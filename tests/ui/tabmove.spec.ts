import { test, expect } from "./fixtures";

const moved = (id: string) => ({
  title: "prod-api",
  dir: "row",
  panes: [{ id, screen: "\u001b[32mdeploy@prod-api\u001b[0m:~$ uptime\r\n 14:02:11 up 31 days\r\n", launched: { program: "ssh", args: ["prod-api"] }, spawn: { program: "ssh", args: ["prod-api"] }, keepOpen: false }],
});

test.describe("вкладка переезжает между окнами", () => {
  test("правый клик по вкладке отдаёт её соседнему окну вместе с сессией", async ({ app, page }) => {
    await app.view("terminal");
    const id = (await app.called("pty_spawn")).args as { req: { id: string } };
    await expect(page.locator(".tabs .tab")).toHaveCount(1);

    await page.locator(".tabs .tab").first().click({ button: "right" });
    await expect(page.locator(".tab-menu")).toContainText("Вынести в отдельное окно");
    await page.locator(".tab-menu [data-a=move]").click();

    // сначала поднимается окно-адресат, и только потом туда уезжает вкладка
    expect((await app.called("window_popout")).args).toEqual({ view: "terminal" });
    const put = (await app.called("term_handoff_put")).args as { to: string; payload: { panes: { id: string; screen: string }[] } };
    expect(put.to).toBe("pop-terminal");
    expect(put.payload.panes[0].id).toBe(id.req.id);
    expect(put.payload.panes[0].screen.length).toBeGreaterThan(0);

    // процесс остаётся жить: закрытия сессии не было
    expect((await app.calls("pty_kill")).filter((c) => c.args.id === id.req.id)).toHaveLength(0);
    // вкладки здесь больше нет (на её месте открылась новая пустая)
    await expect(page.locator(".tabs .tab")).toHaveCount(1);
    await expect(page.locator(".tabs .tab")).not.toContainText("prod-api");
  });

  test("окно-адресат забирает вкладку и подхватывает ту же сессию, не запуская новую", async ({ app, page }) => {
    await app.view("terminal");
    const first = ((await app.called("pty_spawn")).args as { req: { id: string } }).req.id;
    const spawnedBefore = (await app.calls("pty_spawn")).length;

    // бэкенд отдаёт вкладку, оставленную другим окном
    await app.override("term_handoff_take", moved("pty-pop-terminal-7"));
    await page.evaluate(() => (window as any).__demoEmit("term-handoff", "main"));

    // пустая вкладка, которую окно открыло себе при запуске, уступает место приехавшей
    await expect(page.locator(".tabs .tab")).toHaveCount(1);
    await expect(page.locator(".tabs .tab")).toContainText("prod-api");
    expect((await app.called("pty_adopt")).args).toEqual({ id: "pty-pop-terminal-7" });
    // новую оболочку для неё не запускали: процесс тот же
    expect(await app.calls("pty_spawn")).toHaveLength(spawnedBefore);
    expect(first).not.toBe("pty-pop-terminal-7");
    // экран приехал вместе с вкладкой
    await expect(app.terminalText()).toContainText("up 31 days");
  });

  test("если в своей вкладке уже работали, она остаётся: закрывается только нетронутая пустая", async ({ app, page }) => {
    await app.view("terminal");
    await app.called("pty_spawn");
    await page.locator(".term-host:not([hidden]) .xterm").click();
    await page.keyboard.type("ls -la");
    await expect.poll(async () => (await app.calls("pty_write")).length).toBeGreaterThan(0);

    await app.override("term_handoff_take", moved("pty-pop-terminal-7"));
    await page.evaluate(() => (window as any).__demoEmit("term-handoff", "main"));

    await expect(page.locator(".tabs .tab")).toHaveCount(2);
    await expect(page.locator(".tabs .tab").last()).toContainText("prod-api");
  });
});
