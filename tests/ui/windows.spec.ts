import { test, expect } from "./fixtures";

const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const SHELLS = [
  { id: "powershell", label: "Windows PowerShell 5.1", program: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", args: [] },
  { id: "pwsh", label: "PowerShell 7", program: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: [] },
  { id: "gitbash", label: "Git Bash", program: "C:\\Program Files\\Git\\bin\\bash.exe", args: [] },
  { id: "cmd", label: "Командная строка (cmd)", program: "C:\\Windows\\System32\\cmd.exe", args: [] },
  { id: "wsl:Ubuntu-24.04", label: "WSL: Ubuntu-24.04", program: "C:\\Windows\\System32\\wsl.exe", args: ["-d", "Ubuntu-24.04", "--cd", "~"] },
  { id: "wsl:Debian", label: "WSL: Debian", program: "C:\\Windows\\System32\\wsl.exe", args: ["-d", "Debian", "--cd", "~"] },
];
const bg = (page: import("@playwright/test").Page) =>
  page.locator(".term-host:not([hidden]) .xterm-viewport").first().evaluate((e) => getComputedStyle(e).backgroundColor);

test.describe("terminal colour schemes (all systems)", () => {
  test("a built-in scheme applies to open terminals at once", async ({ app, page }) => {
    await app.view("terminal");
    await expect.poll(() => bg(page)).toBe("rgb(15, 17, 23)");
    await app.view("settings");
    await page.selectOption(".term-theme", "Dracula");
    await app.view("terminal");
    await expect.poll(() => bg(page)).toBe("rgb(40, 42, 54)");
    // remembered for the next start
    expect(await page.evaluate(() => localStorage.getItem("opsdeck.term.theme"))).toBe("Dracula");
  });

  test("own JSON scheme can be imported", async ({ app, page }) => {
    await app.view("settings");
    await page.click("[data-theme-import]");
    await page.fill(".theme-json", `{"name": "Mine", "background": "#102030", "foreground": "#eeeeee"}`);
    await page.click("[data-theme-add]");
    await expect(page.locator(".term-theme")).toHaveValue("Mine");
    await expect(page.locator(".theme-import")).toBeHidden();
    await app.view("terminal");
    await expect.poll(() => bg(page)).toBe("rgb(16, 32, 48)");
  });

  test("broken JSON is reported, nothing is added", async ({ app, page }) => {
    await app.view("settings");
    await page.click("[data-theme-import]");
    await page.fill(".theme-json", "{oops");
    await page.click("[data-theme-add]");
    await expect(page.locator(".toast").last()).toContainText("не JSON");
    await expect(page.locator(".theme-import")).toBeVisible();
    await expect(page.locator(".term-theme option")).toHaveCount(5);
  });

  test("Linux/macOS: no Windows block and no WSL button", async ({ app, page }) => {
    await app.view("settings");
    await expect(page.locator(".win-field")).toBeHidden();
    await app.view("terminal");
    await expect(page.locator("[data-act=wsl]")).toBeHidden();
    expect(await app.calls("win_shells")).toEqual([]);
  });
});

test.describe("Windows block", () => {
  test.use({ userAgent: WIN_UA, demo: { overrides: { win_shells: SHELLS } } });

  test("lists installed shells and saves the choice", async ({ app, page }) => {
    await app.view("settings");
    await expect(page.locator(".win-field")).toBeVisible();
    const sel = page.locator("select[name=term_shell]");
    // PowerShell 5.1 is the default entry, not listed twice
    await expect(sel.locator("option")).toHaveText(["Windows PowerShell (по умолчанию)", "PowerShell 7", "Git Bash", "Командная строка (cmd)", "WSL: Ubuntu-24.04", "WSL: Debian"]);
    await sel.selectOption("pwsh");
    await page.locator("section.view:not([hidden]) button[type=submit]", { hasText: "Сохранить" }).click();
    expect(((await app.called("settings_set")).args as any).settings.term_shell).toBe("pwsh");
  });

  test("a saved shell that is gone stays visible", async ({ app, page }) => {
    await app.override("settings_get", { keepass_path: "", keepass_keyfile: "", keepass_lock_minutes: 0, keepass_keep_open: false, obsidian_vault: "", winbox_path: "", k8s_include_system: false, update_auto_check: false, ai_host: "", ai_port: "", ai_model: "", ai_key_saved: false, term_shell: "wsl:Arch" });
    await app.view("settings");
    await expect(page.locator("select[name=term_shell]")).toHaveValue("wsl:Arch");
    await expect(page.locator("select[name=term_shell] option:checked")).toHaveText("wsl:Arch — не найден");
  });

  test("schemes are imported from Windows Terminal", async ({ app, page }) => {
    await app.view("settings");
    await page.click("[data-wt-import]");
    await app.called("wt_settings");
    await expect(page.locator(".term-theme")).toHaveValue("Demo WT");
    await app.view("terminal");
    await expect.poll(() => bg(page)).toBe("rgb(16, 24, 32)");
  });

  test("Windows Terminal not installed: the reason is shown", async ({ app, page }) => {
    await page.evaluate(() => { (window as any).__DEMO_OVERRIDES.wt_settings = () => { throw "Windows Terminal не найден"; }; });
    await app.view("settings");
    await page.click("[data-wt-import]");
    await expect(page.locator(".toast").last()).toContainText("Windows Terminal не найден");
  });

  test("WSL button opens a tab of the chosen distribution", async ({ app, page }) => {
    await app.view("terminal");
    const btn = page.locator("[data-act=wsl]");
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(page.locator(".wsl-menu button")).toHaveText(["Ubuntu-24.04", "Debian"]);
    await page.locator(".wsl-menu button", { hasText: "Debian" }).click();
    await expect(page.locator(".wsl-menu")).toHaveCount(0);
    await expect.poll(async () => (await app.calls("pty_spawn")).map((c) => (c.args as any).req.args)).toContainEqual(["-d", "Debian", "--cd", "~"]);
    await expect(page.locator(".tabs .tab .label").last()).toHaveText("Debian");
  });

  test("Escape closes the WSL menu", async ({ app, page }) => {
    await app.view("terminal");
    await page.click("[data-act=wsl]");
    await expect(page.locator(".wsl-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".wsl-menu")).toHaveCount(0);
  });
});

test.describe("Windows without WSL", () => {
  test.use({ userAgent: WIN_UA, demo: { overrides: { win_shells: SHELLS.slice(0, 2) } } });
  test("no WSL button", async ({ app, page }) => {
    await app.view("terminal");
    await app.called("win_shells");
    await expect(page.locator("[data-act=wsl]")).toBeHidden();
  });
});
