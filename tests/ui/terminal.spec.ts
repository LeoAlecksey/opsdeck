import { test, expect } from "./fixtures";

const tabs = (page: import("@playwright/test").Page) => page.locator(".tabs .tab");
const activeIndex = (page: import("@playwright/test").Page) =>
  tabs(page).evaluateAll((els) => els.findIndex((e) => e.classList.contains("active")));
const panes = (page: import("@playwright/test").Page) => page.locator(".term-host:not([hidden]) .pane");

test.describe("terminal", () => {
  test("shows the shell output and sends typed keys", async ({ app, page }) => {
    await expect(app.terminalText()).toContainText("CrashLoopBackOff");
    await page.locator(".term-host:not([hidden]) .xterm").first().click();
    await page.keyboard.type("ls");
    await expect.poll(async () => (await app.calls("pty_write")).map((c) => c.args.data).join("")).toContain("ls");
  });

  test("tabs: new, switch with Alt+N / Alt+arrows / Ctrl+Tab (#26), close", async ({ app, page }) => {
    await page.keyboard.press("Control+Shift+KeyT");
    await page.locator("[data-act=new]").click();
    await expect(tabs(page)).toHaveCount(3);
    expect(await activeIndex(page)).toBe(2);
    await page.keyboard.press("Alt+Digit1");
    expect(await activeIndex(page)).toBe(0);
    await page.keyboard.press("Alt+Digit9");
    expect(await activeIndex(page)).toBe(2);
    await page.keyboard.press("Alt+ArrowRight");
    expect(await activeIndex(page)).toBe(0);
    await page.keyboard.press("Alt+ArrowLeft");
    expect(await activeIndex(page)).toBe(2);
    await page.keyboard.press("Control+Tab");
    expect(await activeIndex(page)).toBe(0);
    await page.keyboard.press("Control+Shift+Tab");
    expect(await activeIndex(page)).toBe(2);
    await page.keyboard.press("Control+PageUp");
    expect(await activeIndex(page)).toBe(1);
    // the shortcuts must not reach the shell
    expect((await app.calls("pty_write")).map((c) => c.args.data).join("")).not.toMatch(/\x1b\[1;3[CD]/);
    await tabs(page).nth(1).locator(".x").click();
    await expect(tabs(page)).toHaveCount(2);
    expect((await app.calls("pty_kill")).length).toBe(1);
  });

  test("split panes and close one when its shell exits", async ({ app, page }) => {
    await page.keyboard.press("Control+Shift+KeyD");
    await expect(panes(page)).toHaveCount(2);
    const ids = (await app.calls("pty_spawn")).map((c) => (c.args as any).req.id);
    // `exit` in the second shell: the backend reports the end of the process
    await app.emit(`pty-exit-${ids.at(-1)}`, null);
    await expect(panes(page)).toHaveCount(1);
    await page.keyboard.press("Control+Shift+KeyE");
    await expect(panes(page)).toHaveCount(2);
    await page.keyboard.press("Control+Shift+KeyW");
    await expect(panes(page)).toHaveCount(1);
  });

  test("local AI turns words into a command and pastes it without running", async ({ app, page }) => {
    await page.locator(".term-host:not([hidden]) .xterm").first().click();
    await page.keyboard.press("Control+Shift+KeyK");
    const input = page.locator(".aa-in");
    await expect(input).toBeFocused();
    await input.fill("перезапусти воркер в shop");
    await input.press("Enter");
    const call = await app.called("ai_command");
    expect(call.args.request).toBe("перезапусти воркер в shop");
    await expect(page.locator(".aa-cmd")).toContainText("rollout restart deploy/worker");
    await page.locator("[data-aa=paste]").click();
    await expect(page.locator(".ai-ask")).toBeHidden();
    const written = (await app.calls("pty_write")).map((c) => c.args.data as string).join("");
    expect(written).toContain("kubectl -n shop rollout restart deploy/worker");
    expect(written.endsWith("\r"), "paste must not press Enter").toBe(false);
  });

  test("font size buttons and shortcuts", async ({ page }) => {
    const size = page.locator(".font-size");
    await expect(size).toHaveText("13");
    await page.locator("[data-act=font-up]").click();
    await expect(size).toHaveText("14");
    await page.locator(".term-host:not([hidden]) .xterm").first().click(); // the shortcuts work in the terminal
    await page.keyboard.press("Control+Minus");
    await page.keyboard.press("Control+Minus");
    await expect(size).toHaveText("12");
    await page.keyboard.press("Control+Digit0");
    await expect(size).toHaveText("13");
  });

  test("session recording and the AI panel", async ({ app, page }) => {
    await app.override("pty_record_start", "/home/demo/Documents/OpsDeck/sessions/x.log");
    await page.locator("[data-act=rec]").click();
    await app.called("pty_record_start");
    await page.locator("[data-act=ai]").click();
    await expect(page.locator(".ai-panel")).toBeVisible();
    await expect.poll(async () => (await app.calls("pty_spawn")).map((c) => (c.args as any).req.program)).toContain("claude");
  });
});
