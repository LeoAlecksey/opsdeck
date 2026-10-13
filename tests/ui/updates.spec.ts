import { test, expect } from "./fixtures";

// Settings are mounted at every start; mounting them must not ask the release server.
// The startup check runs 8 s after start (main.ts), hence the long waits.
const settings = { keepass_path: "", keepass_keyfile: "", keepass_lock_minutes: 0, keepass_keep_open: true, obsidian_vault: "", winbox_path: "", k8s_include_system: false, ai_host: "", ai_port: "", ai_model: "", ai_key_saved: false, term_shell: "" };
const newer = { current: "0.5.0", available: true, version: "0.6.0", notes: "Исправления", date: 1790000000, rollback: false };

test.describe("startup check off", () => {
  test.use({ demo: { overrides: { settings_get: { ...settings, update_auto_check: false }, update_check: { current: "0.5.0", available: false, rollback: false } } } });

  test("no update_check until the button; the installed version is shown", async ({ app, page }) => {
    await app.view("settings");
    await expect(page.locator(".upd-cur")).toHaveText("0.5.0");
    await page.waitForTimeout(9000);
    expect(await app.calls("update_check")).toHaveLength(0);

    await page.click("[data-u=check]");
    await expect(page.locator(".upd-result")).toHaveText("✓ Это последняя версия");
    expect(await app.calls("update_check")).toHaveLength(1);
  });
});

test.describe("startup check on", () => {
  test.use({ demo: { overrides: { settings_get: { ...settings, update_auto_check: true }, update_check: newer } } });

  test("one update_check, by the startup check, and settings show its result", async ({ app, page }) => {
    await app.view("settings");
    await expect(page.locator(".upd-cur")).toHaveText("0.5.0");
    expect(await app.calls("update_check")).toHaveLength(0);

    await expect.poll(async () => (await app.calls("update_check")).length, { timeout: 12_000 }).toBe(1);
    await expect(page.locator(".upd-title")).toHaveText(/^Доступна версия 0\.6\.0/);
    await expect(page.locator("#sidebar [data-view=settings]")).toHaveClass(/has-update/);
    await page.waitForTimeout(1000);
    expect(await app.calls("update_check")).toHaveLength(1);
  });

  test("a failed startup check is shown in settings", async ({ app, page }) => {
    await page.evaluate(() => { (window as any).__DEMO_OVERRIDES.update_check = () => { throw "сеть недоступна"; }; });
    await app.view("settings");
    await expect(page.locator(".upd-result")).toHaveText("сеть недоступна", { timeout: 12_000 });
    expect((await app.calls("log_ui")).some((c) => String(c.args.message).includes("сеть недоступна"))).toBe(true);
  });
});
