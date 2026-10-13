import { test, expect } from "./fixtures";

const tabs = (page: import("@playwright/test").Page) => page.locator(".tabs .tab");
const activeIndex = (page: import("@playwright/test").Page) =>
  tabs(page).evaluateAll((els) => els.findIndex((e) => e.classList.contains("active")));
const panes = (page: import("@playwright/test").Page) => page.locator(".term-host:not([hidden]) .pane");
/** Backend events of one terminal that still have a listener (the fake backend tracks unlisten). */
const listeners = (page: import("@playwright/test").Page, id: string) => page.evaluate((id) =>
  Object.entries((window as any).__demoListeners as Record<string, number[]>)
    .filter(([e, l]) => e.endsWith(`-${id}`) && l.length).map(([e]) => e.slice(0, -id.length - 1)).sort(), id);

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

  // a listener left behind holds the closed pane with its whole scrollback
  test("a closed tab and a reconnected pane leave no event listeners", async ({ app, page }) => {
    const spawned = async () => ((await app.calls("pty_spawn")).at(-1)!.args as any).req;
    await app.called("pty_spawn");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-terminal", { detail: { program: "ssh", args: ["demo"], keepOpen: true } })));
    await expect.poll(async () => (await spawned()).program).toBe("ssh");
    const first = (await spawned()).id;
    await expect.poll(() => listeners(page, first)).toEqual(["pty-data", "pty-exit", "pty-record"]);

    await app.emit(`pty-exit-${first}`, null);
    await page.locator(".reconnect-bar:visible [data-rc=go]").click();
    await expect.poll(async () => (await spawned()).id).not.toBe(first);
    const second = (await spawned()).id;
    await expect.poll(() => listeners(page, second)).toEqual(["pty-data", "pty-exit", "pty-record"]);
    expect(await listeners(page, first), "reconnect drops the old terminal's listeners").toEqual([]);

    // a recording tab saves its file on close: no listener is left to hear the backend's «saved»
    await app.override("pty_record_start", "/home/demo/sessions/x.log");
    await app.override("pty_record_stop", "/home/demo/sessions/x.log");
    await page.locator("[data-act=rec]").click();
    await app.called("pty_record_start");
    await tabs(page).last().locator(".x").click();
    expect(((await app.called("pty_record_stop")).args as any).id).toBe(second);
    await expect(page.locator(".toast").last()).toContainText("Запись сохранена: /home/demo/sessions/x.log");
    await expect.poll(() => listeners(page, second), "closing the tab drops its listeners").toEqual([]);
  });

  // reconnect replaces the terminal, so the recording of the old one has to be saved here too
  test("reconnecting a recording pane saves its file and turns the indicator off", async ({ app, page }) => {
    await app.called("pty_spawn");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-terminal", { detail: { program: "ssh", args: ["demo"], keepOpen: true } })));
    const id = async () => ((await app.calls("pty_spawn")).at(-1)!.args as any).req.id as string;
    await expect.poll(async () => ((await app.calls("pty_spawn")).at(-1)!.args as any).req.program).toBe("ssh");
    const first = await id();
    await app.override("pty_record_start", "/home/demo/sessions/r.log");
    await app.override("pty_record_stop", "/home/demo/sessions/r.log");
    await page.locator("[data-act=rec]").click();
    await app.called("pty_record_start");
    await expect(page.locator("[data-act=rec]")).toHaveClass(/\bon\b/);

    await app.emit(`pty-exit-${first}`, null);
    await page.locator(".reconnect-bar:visible [data-rc=go]").click();
    expect(((await app.called("pty_record_stop")).args as any).id).toBe(first);
    await expect(page.locator(".toast").last()).toContainText("Запись сохранена: /home/demo/sessions/r.log");
    await expect(page.locator("[data-act=rec]")).not.toHaveClass(/\bon\b/);
    await expect.poll(async () => await id()).not.toBe(first);
  });

  test("a tab closed before its shell started starts no shell", async ({ app, page }) => {
    await app.called("pty_spawn");
    // open and close in one go: the close lands while the terminal is still subscribing to its events
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("open-terminal", { detail: {} }));
      document.querySelector<HTMLElement>(".tabs .tab:last-child .x")!.click();
    });
    const closed = ((await app.called("pty_kill")).args as any).id as string;
    // a tab opened afterwards subscribes and spawns later than the closed one would have
    await page.keyboard.press("Control+Shift+KeyT");
    await expect(tabs(page)).toHaveCount(2);
    await expect.poll(async () => (await app.calls("pty_spawn")).length).toBeGreaterThanOrEqual(2);
    expect((await app.calls("pty_spawn")).map((c) => (c.args as any).req.id), "no shell for the closed tab").not.toContain(closed);
    expect(await listeners(page, closed), "no listeners of the closed tab").toEqual([]);
  });

  // «открыть папку в web»: папка раздаётся на 127.0.0.1 хоста, браузер приходит через ssh -L
  test("sharing the session folder over http runs the server, opens a tunnel and a link", async ({ app, page }) => {
    await app.called("pty_spawn");
    await app.override("web_share_tunnel", 41234);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-terminal", { detail: { program: "ssh", args: ["-p", "2222", "ops@198.51.100.7"], keepOpen: true } })));
    await expect.poll(async () => ((await app.calls("pty_spawn")).at(-1)!.args as any).req.program).toBe("ssh");

    await page.locator("[data-act=web-share]").click();
    const typedText = async () => (await app.calls("pty_write")).map((c) => (c.args as any).data).join("");
    await expect.poll(typedText).toContain("http.server");
    const text = await typedText();
    const port = Number(text.match(/http\.server (\d+)/)![1]);
    expect(port).toBeGreaterThanOrEqual(8000);
    expect(text).toContain("--bind 127.0.0.1"); // наружу папка не светится
    // туннель — к адресу этой же сессии, с её портом и пользователем
    expect((await app.called("web_share_tunnel")).args).toEqual({ dest: ["-p", "2222", "ops@198.51.100.7"], port });
    expect((await app.called("open_external")).args).toEqual({ url: "http://127.0.0.1:41234/" });
    await expect(page.locator(".toast").last()).toContainText("http://127.0.0.1:41234/");

    // вкладку закрыли — туннель не остаётся
    await page.locator(".tabs .tab").last().locator(".x").click();
    expect((await app.called("web_share_close")).args).toEqual({ dest: ["-p", "2222", "ops@198.51.100.7"] });
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
