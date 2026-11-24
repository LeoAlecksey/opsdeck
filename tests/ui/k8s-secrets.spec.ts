import { test, expect } from "./fixtures";

// a PEM certificate (several lines) and a binary value (gzip header), as base64 like the API returns them
const pem = "-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIEAgAAuTANBgkqhkiG9w0BAQUFADBaMQswCQYDVQQGEwJJ\nRTESMBAGA1UEChMJQmFsdGltb3JlMRMwEQYDVQQLEwpDeWJlclRydXN0MSIwIAYD\n-----END CERTIFICATE-----\n";
const b64 = (s: string) => Buffer.from(s).toString("base64");
const gz = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xed, 0xfd, 0x07, 0x5c, 0x14, 0x57, 0xd7]).toString("base64");
const secret = {
  metadata: { name: "tls-cert", namespace: "shop", uid: "s1", resourceVersion: "1", creationTimestamp: "2026-10-01T10:00:00Z" },
  type: "kubernetes.io/tls",
  data: { "tls.crt": b64(pem), "release": gz, "password": b64("p@ss w0rd") },
};

test.describe("kubernetes secrets (#67)", () => {
  test.use({ demo: { overrides: { k8s_prefs_get: { hidden: [], readonly: [] } } } });
  test.beforeEach(async ({ app, page }) => {
    await app.view("k8s");
    await page.locator(".ctx-item", { has: page.locator(".ctx-name", { hasText: "prod-eu" }) }).click();
    await page.evaluate((s) => {
      (window as any).__DEMO_OVERRIDES.k8s_watch_start = (args: any) => {
        setTimeout(() => (window as any).__demoEmit(`k8s-watch-${args.id}`, { type: "reset", items: args.kind === "secrets" ? [s] : [] }), 50);
        return null;
      };
    }, secret);
    await page.locator(".kind-list button", { hasText: "Secrets" }).click();
    await page.locator(".k8s-main .table-wrap tbody tr", { hasText: "tls-cert" }).click();
    await expect(page.locator(".drawer")).toBeVisible();
  });

  test("a certificate is shown whole, under its key, over the full width", async ({ page }) => {
    const row = page.locator('.drawer .dtable tr', { has: page.locator('[data-secret="tls.crt"]') });
    await row.locator("[data-secret]").click();
    const value = page.locator(".drawer .secret-row .secret-value").first();
    await expect(value).toContainText("BEGIN CERTIFICATE");
    await expect(value).toContainText("-----END CERTIFICATE-----");
    // lines stay lines, and the block is as wide as the table, not a squeezed cell
    const [v, t] = await Promise.all([value.boundingBox(), page.locator(".drawer .dtable").boundingBox()]);
    expect(v!.width).toBeGreaterThan(t!.width * 0.8);
    expect(v!.height).toBeLessThan(200);
    // the header of the keys table does not stay on top of the value while the drawer scrolls
    expect(await page.locator(".drawer .dtable th").first().evaluate((el) => getComputedStyle(el).position)).toBe("static");
    // the same button hides it again
    await row.locator("[data-secret]").click();
    await expect(page.locator(".drawer .secret-row")).toHaveCount(0);
  });

  test("binary data is not shown as garbage: a note and base64 instead", async ({ page }) => {
    await page.locator('.drawer [data-secret="release"]').click();
    const row = page.locator(".drawer .secret-row");
    await expect(row).toContainText("Бинарные данные, 17 байт");
    await expect(row.locator(".secret-value")).toContainText(gz.slice(0, 20));
  });

  test("the key toggles the value and copy preserves its exact text", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const key = page.locator('.drawer [data-secret-key="tls.crt"]');
    await key.click();
    await page.locator('.drawer [data-secret-copy="tls.crt"]').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(pem);
    await key.click();
    await expect(page.locator(".drawer .secret-row")).toHaveCount(0);
    await expect(page.locator('.drawer [data-secret="tls.crt"]')).toHaveText("показать");
  });

  test("plain text values are shown as they are", async ({ page }) => {
    await page.locator('.drawer [data-secret="password"]').click();
    await expect(page.locator(".drawer .secret-row .secret-value")).toHaveText("p@ss w0rd");
  });
  test("editing a secret preserves whitespace and updates only the selected key", async ({ app, page }) => {
    await page.locator('.drawer [data-secret="tls.crt"]').click();
    await page.getByRole('button', { name: 'Изменить / вставить' }).click();
    const value = "  пароль\nline two\n";
    await page.locator('.secret-editor').fill(value);
    await page.getByRole('button', { name: 'Сохранить значение' }).click();
    const call = await app.called('k8s_secret_set');
    expect(call.args).toMatchObject({ namespace: 'shop', name: 'tls-cert', key: 'tls.crt', resourceVersion: '1', value: b64(value) });
    await expect(page.locator('.secret-editor')).toHaveCount(0);
  });

  test("cancel does not write a secret", async ({ app, page }) => {
    await page.locator('.drawer [data-secret="password"]').click();
    await page.getByRole('button', { name: 'Изменить / вставить' }).click();
    await page.locator('.secret-editor').fill('replacement');
    await page.locator('.secret-row').getByRole('button', { name: 'Отмена', exact: true }).click();
    expect(await app.calls('k8s_secret_set')).toHaveLength(0);
  });

  test("paste preserves exact clipboard text; failed save keeps the editor", async ({ app, page }) => {
    await app.override('clip_read', '  pasted\n');
    await page.evaluate(() => { (window as any).__DEMO_OVERRIDES.k8s_secret_set = () => { throw 'Conflict'; }; });
    await page.locator('.drawer [data-secret="password"]').click();
    await page.getByRole('button', { name: 'Изменить / вставить' }).click();
    await page.getByRole('button', { name: 'Вставить из буфера', exact: true }).click();
    await expect(page.locator('.secret-editor')).toHaveValue('  pasted\n');
    await page.getByRole('button', { name: 'Сохранить значение' }).click();
    await expect(page.locator('.secret-editor')).toHaveValue('  pasted\n');
    await expect(page.getByRole('button', { name: 'Сохранить значение' })).toBeEnabled();
    expect((await app.called('k8s_secret_set')).args.value).toBe(b64('  pasted\n'));
  });

  test("binary editing sends base64 and rejects malformed input", async ({ app, page }) => {
    await page.locator('.drawer [data-secret="release"]').click();
    await page.getByRole('button', { name: 'Изменить / вставить' }).click();
    await page.locator('.secret-editor').fill('%%%');
    await page.getByRole('button', { name: 'Сохранить значение' }).click();
    expect(await app.calls('k8s_secret_set')).toHaveLength(0);
    await page.locator('.secret-editor').fill(gz);
    await page.getByRole('button', { name: 'Сохранить значение' }).click();
    expect((await app.called('k8s_secret_set')).args.value).toBe(gz);
  });

});
