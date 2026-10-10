// Test data on the test Passbolt server of ../docker-compose.yml: an admin without MFA and a user with
// TOTP, a shared metadata key, resources of every v4 and v5 type, account kits and a recovery kit.
//
//	cd tests/passbolt/seed && go run .     → tests/passbolt/out/*, tests/passbolt/.env.test
//
// Live tests of the integration (src-tauri):
//
//	set -a; . ../tests/passbolt/.env.test; set +a; cargo test --lib passbolt_live -- --ignored --test-threads=1
//
// Seeds a fresh server only; to reseed: docker compose -f tests/passbolt/docker-compose.yml down -v, up -d.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/ProtonMail/gopenpgp/v3/crypto"
	"github.com/passbolt/go-passbolt/api"
	"github.com/passbolt/go-passbolt/helper"
)

const (
	baseURL = "http://127.0.0.1:8090"
	compose = "../docker-compose.yml"
)

type account struct {
	id, email, first, last, role, passphrase string
	privateKey, publicKey                     string
}

var (
	admin = &account{email: "admin@opsdeck.example.com", first: "Ada", last: "Admin", role: "admin", passphrase: "opsdeck admin passphrase"}
	user  = &account{email: "user@opsdeck.example.com", first: "Uma", last: "User", role: "user", passphrase: "opsdeck user passphrase"}
)

func main() {
	ctx := context.Background()
	out, err := filepath.Abs("../out")
	if err != nil {
		log.Fatalf("output directory: %v", err)
	}
	env := filepath.Join(out, "..", ".env.test")
	if seeded(ctx, env) {
		fmt.Println("already seeded:", env)
		return
	}
	for _, a := range []*account{admin, user} {
		if err := register(ctx, a); err != nil {
			log.Fatalf("register %s: %v", a.email, err)
		}
	}
	ac := login(ctx, admin)
	folder, err := helper.CreateFolder(ctx, ac, "", "Servers")
	must(err, "create folder")
	// v4 types are the defaults of a fresh server
	totp := map[string]any{"secret_key": "JBSWY3DPEHPK3PXP", "period": 30, "digits": 6, "algorithm": "SHA1"}
	create(ctx, ac, "password-and-description", folder,
		map[string]any{"name": "Router v4", "username": "admin", "uri": "https://192.0.2.1"},
		map[string]any{"password": "v4-router-pass", "description": "v4 description: encrypted"})
	create(ctx, ac, "password-string", "",
		map[string]any{"name": "Legacy v4 string", "username": "root", "uri": "ssh://192.0.2.2", "description": "v4 cleartext description"},
		map[string]any{"password": "v4-legacy-pass"})
	create(ctx, ac, "password-description-totp", "",
		map[string]any{"name": "v4 with TOTP", "username": "ops", "uri": "https://v4totp.example.com"},
		map[string]any{"password": "v4-totp-pass", "description": "v4 + totp", "totp": totp})
	create(ctx, ac, "totp", "",
		map[string]any{"name": "v4 TOTP only", "uri": "https://otp.example.com"},
		map[string]any{"totp": totp})

	must(enableV5(ctx, ac), "enable v5")
	ac = login(ctx, admin) // the client caches the type settings at login
	// v5 folders (encrypted names) are refused by 5.11: "Could not validate folder history data"
	create(ctx, ac, "v5-default", folder,
		map[string]any{"name": "Сервер v5 personal", "username": "deploy", "uris": []string{"https://v5.example.com", "https://alt.example.com"}},
		map[string]any{"password": "v5-personal-pass", "description": "Описание v5"})
	shared := create(ctx, ac, "v5-default", folder,
		map[string]any{"name": "Shared v5", "username": "shared", "uris": []string{"ssh://192.0.2.10:2222"}},
		map[string]any{"password": "v5-shared-pass", "description": "shared with the user"})
	// sharing moves the metadata from the personal key to the shared metadata key
	must(helper.ShareResourceWithUsersAndGroups(ctx, ac, shared, []string{user.id}, nil, 1), "share v5 resource")
	// v5-password-string is not created directly: the server makes it only when upgrading v4 resources
	create(ctx, ac, "v5-default-with-totp", "",
		map[string]any{"name": "v5 with TOTP", "username": "ops5", "uris": []string{"https://v5totp.example.com"}},
		map[string]any{"password": "v5-totp-pass", "description": "v5 + totp", "totp": totp})
	create(ctx, ac, "v5-totp-standalone", "",
		map[string]any{"name": "v5 TOTP only", "uris": []string{"https://otp5.example.com"}},
		map[string]any{"totp": totp})
	create(ctx, ac, "v5-note", "",
		map[string]any{"name": "v5 note"},
		map[string]any{"description": "a secure note\nsecond line"})
	cf := "7c1fe1b5-6a3e-4d4c-9a39-2d6f8b9a0c11"
	create(ctx, ac, "v5-custom-fields", "",
		map[string]any{"name": "v5 custom fields", "custom_fields": []map[string]any{{"id": cf, "type": "text", "metadata_key": "port"}}},
		map[string]any{"custom_fields": []map[string]any{{"id": cf, "type": "text", "secret_value": "2222"}}})

	_, err = ac.DoCustomRequestV5(ctx, "POST", "/mfa/settings.json", map[string]any{"providers": []string{"totp"}}, nil)
	must(err, "enable TOTP for the organization")
	uc := login(ctx, user)
	secret := setupTotp(ctx, uc)
	serverKey, serverFingerprint, err := ac.GetPublicKey(ctx)
	must(err, "server key")
	must(os.MkdirAll(out, 0o755), "output directory")
	for _, a := range []*account{admin, user} {
		kit := filepath.Join(out, strings.Split(a.email, "@")[0]+".passbolt")
		must(writeAccountKit(kit, a, serverKey), "account kit "+a.email)
	}
	must(os.WriteFile(filepath.Join(out, "admin-recovery-kit.asc"), []byte(admin.privateKey), 0o600), "recovery kit")
	lines := []string{
		"PB_URL=" + baseURL,
		"PB_SERVER_FINGERPRINT=" + serverFingerprint,
		"PB_ADMIN_ID=" + admin.id,
		"PB_ADMIN_KIT=" + filepath.Join(out, "admin.passbolt"),
		"PB_ADMIN_RECOVERY_KIT=" + filepath.Join(out, "admin-recovery-kit.asc"),
		"PB_ADMIN_PASSPHRASE='" + admin.passphrase + "'",
		"PB_USER_ID=" + user.id,
		"PB_USER_KIT=" + filepath.Join(out, "user.passbolt"),
		"PB_USER_PASSPHRASE='" + user.passphrase + "'",
		"PB_USER_TOTP=" + secret,
	}
	must(os.WriteFile(env, []byte(strings.Join(lines, "\n")+"\n"), 0o600), "env file")
	fmt.Println("written", env)
}

func must(err error, what string) {
	var apiErr *api.APIError
	if errors.As(err, &apiErr) {
		log.Fatalf("%s: %v\n%s", what, err, apiErr.Body)
	}
	if err != nil {
		log.Fatalf("%s: %v", what, err)
	}
}

// seeded: the env file of an earlier run exists and its admin still logs in
func seeded(ctx context.Context, env string) bool {
	if _, err := os.Stat(env); errors.Is(err, os.ErrNotExist) {
		return false
	}
	kit := filepath.Join(filepath.Dir(env), "out", "admin-recovery-kit.asc")
	key, err := os.ReadFile(kit)
	if err != nil {
		log.Fatalf("%s exists but %s cannot be read (%v); remove the env file to reseed a fresh server", env, kit, err)
	}
	c, err := api.NewClient(nil, "opsdeck-seed", baseURL, string(key), admin.passphrase)
	must(err, "client")
	if err := c.Login(ctx); err != nil {
		log.Fatalf("%s exists but its admin does not log in (%v); for a fresh server remove the env file", env, err)
	}
	return true
}

var setupURL = regexp.MustCompile(`https?://\S+/setup/[A-Za-z]+/([0-9a-f-]{36})/([0-9a-f-]{36})`)

func register(ctx context.Context, a *account) error {
	cake := fmt.Sprintf("bin/cake passbolt register_user -u %s -f %s -l %s -r %s", a.email, a.first, a.last, a.role)
	cmd := exec.CommandContext(ctx, "docker", "compose", "-f", compose, "exec", "-T", "passbolt",
		"su", "-m", "-c", cake, "-s", "/bin/sh", "www-data")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("register_user: %v\n%s", err, output)
	}
	m := setupURL.FindSubmatch(output)
	if m == nil {
		return fmt.Errorf("no setup URL in the register_user output:\n%s", output)
	}
	a.id = string(m[1])
	c, err := api.NewClient(nil, "opsdeck-seed", baseURL, "", "")
	if err != nil {
		return err
	}
	a.privateKey, err = helper.SetupAccount(ctx, c, a.id, string(m[2]), a.passphrase)
	if err != nil {
		return fmt.Errorf("setup: %w", err)
	}
	key, err := crypto.NewKeyFromArmored(a.privateKey)
	if err != nil {
		return err
	}
	a.publicKey, err = key.GetArmoredPublicKey()
	return err
}

func login(ctx context.Context, a *account) *api.Client {
	c, err := api.NewClient(nil, "opsdeck-seed", baseURL, a.privateKey, a.passphrase)
	must(err, "client "+a.email)
	must(c.Login(ctx), "login "+a.email)
	return c
}

func create(ctx context.Context, c *api.Client, slug, folder string, meta, secret map[string]any) string {
	id, err := helper.CreateResourceGeneric(ctx, c, slug, folder, meta, secret)
	must(err, "create "+slug)
	return id
}

// enableV5: a shared metadata key for both users, then v5 as the default type (like go-passbolt's testenv)
func enableV5(ctx context.Context, c *api.Client) error {
	pgp := c.GetPGPHandle()
	key, err := pgp.KeyGeneration().AddUserId("Passbolt Shared Metadata Key", "metadata@opsdeck.example.com").New().GenerateKey()
	if err != nil {
		return err
	}
	defer key.ClearPrivateParams()
	public, err := key.GetArmoredPublicKey()
	if err != nil {
		return err
	}
	private, err := key.Armor()
	if err != nil {
		return err
	}
	// the server validates the fingerprint in upper case
	fingerprint := strings.ToUpper(key.GetFingerprint())
	payload, err := json.Marshal(api.MetadataPrivateKeyData{
		ObjectType: "PASSBOLT_METADATA_PRIVATE_KEY", Domain: baseURL, Fingerprint: fingerprint,
		ArmoredKey: private, Signed: api.Time{Time: time.Now()},
	})
	if err != nil {
		return err
	}
	body := api.MetadataKey{Fingerprint: fingerprint, ArmoredKey: public}
	for _, a := range []*account{admin, user} {
		pub, err := crypto.NewKeyFromArmored(a.publicKey)
		if err != nil {
			return err
		}
		data, err := c.EncryptMessageWithKey(pub, string(payload))
		if err != nil {
			return err
		}
		id := a.id
		body.MetadataPrivateKeys = append(body.MetadataPrivateKeys, api.MetadataPrivateKey{UserID: &id, Data: data})
	}
	if _, err := c.DoCustomRequestV5(ctx, "POST", "/metadata/keys.json", body, nil); err != nil {
		return fmt.Errorf("metadata key: %w", err)
	}
	types := api.MetadataTypeSettings{
		DefaultResourceType: api.PassboltAPIVersionTypeV5, DefaultFolderType: api.PassboltAPIVersionTypeV5,
		DefaultTagType: api.PassboltAPIVersionTypeV5, DefaultCommentType: api.PassboltAPIVersionTypeV5,
		AllowCreationOfV5Resources: true, AllowCreationOfV5Folders: true, AllowCreationOfV5Tags: true, AllowCreationOfV5Comments: true,
		AllowCreationOfV4Resources: true, AllowCreationOfV4Folders: true, AllowCreationOfV4Tags: true, AllowCreationOfV4Comments: true,
		AllowV4V5Upgrade: true, AllowV4V5Downgrade: true,
	}
	if _, err := c.DoCustomRequestV5(ctx, "POST", "/metadata/types/settings.json", types, nil); err != nil {
		return fmt.Errorf("type settings: %w", err)
	}
	keys := api.MetadataKeySettings{AllowUsageOfPersonalKeys: true, AllowZeroKnowledgeKeyShare: false}
	if _, err := c.DoCustomRequestV5(ctx, "POST", "/metadata/keys/settings.json", keys, nil); err != nil {
		return fmt.Errorf("key settings: %w", err)
	}
	return nil
}

// setupTotp enables TOTP for the logged-in user with the URI the server proposes; returns its secret
func setupTotp(ctx context.Context, c *api.Client) string {
	res, err := c.DoCustomRequestV5(ctx, "GET", "/mfa/setup/totp.json", nil, nil)
	must(err, "TOTP setup URI")
	var setup struct {
		URI string `json:"otpProvisioningUri"`
	}
	must(json.Unmarshal(res.Body, &setup), "TOTP setup answer")
	u, err := url.Parse(setup.URI)
	must(err, "TOTP URI")
	secret := u.Query().Get("secret")
	code, err := helper.GenerateOTPCode(secret, time.Now())
	must(err, "TOTP code")
	_, err = c.DoCustomRequestV5(ctx, "POST", "/mfa/setup/totp.json", map[string]string{"otpProvisioningUri": setup.URI, "totp": code}, nil)
	must(err, "TOTP setup")
	return secret
}

// writeAccountKit writes the file of "Desktop app setup" in the browser extension:
// base64 of the JSON account, clear-signed by the user's key
func writeAccountKit(path string, a *account, serverKey string) error {
	kit, err := json.Marshal(map[string]any{
		"domain": baseURL, "user_id": a.id, "username": a.email, "first_name": a.first, "last_name": a.last,
		"user_private_armored_key": a.privateKey, "user_public_armored_key": a.publicKey,
		"server_public_armored_key": serverKey,
		"security_token":            map[string]string{"code": "QDT", "color": "#2f6f9f", "textcolor": "#ffffff"},
	})
	if err != nil {
		return err
	}
	locked, err := crypto.NewKeyFromArmored(a.privateKey)
	if err != nil {
		return err
	}
	key, err := locked.Unlock([]byte(a.passphrase))
	if err != nil {
		return err
	}
	defer key.ClearPrivateParams()
	signer, err := crypto.PGP().Sign().SigningKey(key).New()
	if err != nil {
		return err
	}
	signed, err := signer.SignCleartext(kit)
	if err != nil {
		return err
	}
	return os.WriteFile(path, []byte(base64.StdEncoding.EncodeToString(signed)), 0o600)
}
