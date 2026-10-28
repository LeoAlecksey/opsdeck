import { test, expect } from "./fixtures";

// #99: вставка правой кнопкой, как в PuTTY, и «копировать выделение, иначе вставить», как в Windows Terminal
test.describe("right mouse button in the terminal (#99)", () => {
  const term = (page: import("@playwright/test").Page) => page.locator(".term-host:not([hidden]) .xterm").first();
  const written = async (app: { calls: (c: string) => Promise<{ args: any }[]> }, from: number) =>
    (await app.calls("pty_write")).slice(from).map((c) => c.args.data).join("");

  async function choose(app: { view: (id: string) => Promise<void> }, page: import("@playwright/test").Page, mode: string) {
    await app.view("settings");
    await page.selectOption(".term-rclick", mode);
    await app.view("terminal");
  }

  test("by default it is the usual menu: nothing is pasted", async ({ app, page }) => {
    await app.view("settings");
    await expect(page.locator(".term-rclick")).toHaveValue("menu");
    await app.view("terminal");
    await app.override("clip_read", "whoami");
    const before = (await app.calls("pty_write")).length;
    await term(page).click({ button: "right" });
    await page.waitForTimeout(200);
    expect(await app.calls("clip_read")).toHaveLength(0);
    expect(await written(app, before)).not.toContain("whoami");
  });

  test("PuTTY: a right click pastes the clipboard, and the choice is remembered", async ({ app, page }) => {
    await choose(app, page, "paste");
    await app.override("clip_read", "kubectl get pods\nkubectl get svc");
    const before = (await app.calls("pty_write")).length;
    await term(page).click({ button: "right" });
    await expect.poll(() => written(app, before)).toContain("kubectl get pods");
    // тем же путём, что Ctrl+Shift+V (term.paste): обе строки, одной вставкой
    expect(await written(app, before)).toContain("kubectl get svc");
    expect(await app.calls("clip_read")).toHaveLength(1);
    // запомнено вместе с остальными настройками терминала
    expect(await page.evaluate(() => localStorage.getItem("opsdeck.term.rightClick"))).toBe("paste");
  });

  test("Windows Terminal: a selection is copied (not pasted), without one the clipboard is pasted", async ({ app, page }) => {
    await page.evaluate(() => {
      (window as any).__copied = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { (window as any).__copied.push(t); } } });
    });
    await choose(app, page, "copy-paste");
    await app.override("clip_read", "uptime");
    // выделить слово двойным кликом по выводу терминала
    await app.terminalText().getByText("CrashLoopBackOff").first().dblclick();
    const before = (await app.calls("pty_write")).length;
    await term(page).click({ button: "right" });
    await expect.poll(() => page.evaluate(() => (window as any).__copied as string[])).toEqual(["CrashLoopBackOff"]);
    expect(await written(app, before)).toBe("");
    // выделение снято — следующий правый клик уже вставляет
    await term(page).click({ button: "right" });
    await expect.poll(() => written(app, before)).toContain("uptime");
  });
});
