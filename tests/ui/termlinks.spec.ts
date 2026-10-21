import { test, expect } from "./fixtures";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const lastPty = async (app: { calls: (c?: string) => Promise<{ args: Record<string, unknown> }[]> }) =>
  ((await app.calls("pty_spawn")).at(-1)!.args as { req: { id: string } }).req.id;

// Из отчёта: поднял python-сервер в терминале — перейти на него было не из чего.
test.describe("адрес в выводе терминала", () => {
  test("Ctrl+клик по 0.0.0.0 открывает 127.0.0.1: слушать на всех адресах можно, ходить туда нельзя", async ({ app, page }) => {
    await app.view("terminal");
    const id = await lastPty(app);
    await app.emit(`pty-data-${id}`, b64("Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...\r\n"));
    const link = page.locator(".term-host:not([hidden]) .xterm-rows span", { hasText: "http://0.0.0.0:8000/" }).first();
    await expect(link).toBeVisible();
    await link.click({ modifiers: ["Control"] });
    expect((await app.called("open_external")).args).toEqual({ url: "http://127.0.0.1:8000/" });
    // своя машина — туннель не нужен
    expect(await app.calls("web_share_tunnel")).toHaveLength(0);
  });

  test("в ssh-сессии localhost — это localhost хоста, поэтому поднимается туннель к его порту", async ({ app, page }) => {
    await app.view("terminal");
    await app.override("web_share_tunnel", 41234);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-terminal", { detail: { program: "ssh", args: ["ops@198.51.100.7"], keepOpen: true } })));
    await expect.poll(async () => ((await app.calls("pty_spawn")).at(-1)!.args as any).req.program).toBe("ssh");
    const id = await lastPty(app);

    await app.emit(`pty-data-${id}`, b64("  ➜  Local:   http://localhost:5173/\r\n"));
    const link = page.locator(".term-host:not([hidden]) .xterm-rows span", { hasText: "http://localhost:5173/" }).first();
    await expect(link).toBeVisible();
    await link.click({ modifiers: ["Control"] });

    expect((await app.called("web_share_tunnel")).args).toEqual({ dest: ["ops@198.51.100.7"], port: 5173, host: "127.0.0.1" });
    expect((await app.called("open_external")).args).toEqual({ url: "http://127.0.0.1:41234/" });

    // туннель уходит вместе с вкладкой
    await page.locator(".tabs .tab").last().locator(".x").click();
    expect((await app.called("web_share_close")).args).toEqual({ dest: ["ops@198.51.100.7"] });
  });

  // из отчёта: сервер печатает своё короткое имя, и снаружи той сети такого имени нет
  test("короткое имя хоста из вывода доезжает через туннель на этот же хост", async ({ app, page }) => {
    await app.view("terminal");
    await app.override("web_share_tunnel", 41235);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-terminal", { detail: { program: "ssh", args: ["ops@198.51.100.7"], keepOpen: true } })));
    await expect.poll(async () => ((await app.calls("pty_spawn")).at(-1)!.args as any).req.program).toBe("ssh");
    const id = await lastPty(app);

    await app.emit(`pty-data-${id}`, b64("[MailHog] Serving under http://adas-adcu-build-3:8025/\r\n"));
    const link = page.locator(".term-host:not([hidden]) .xterm-rows span", { hasText: "adas-adcu-build-3:8025" }).first();
    await expect(link).toBeVisible();
    await link.click({ modifiers: ["Control"] });

    // ssh -L ведёт на сам этот хост, а не на loopback: имя живёт только в сети хоста сессии
    expect((await app.called("web_share_tunnel")).args).toEqual({ dest: ["ops@198.51.100.7"], port: 8025, host: "adas-adcu-build-3" });
    expect((await app.called("open_external")).args).toEqual({ url: "http://127.0.0.1:41235/" });
  });

  test("адрес настоящего хоста открывается как есть, без туннелей", async ({ app, page }) => {
    await app.view("terminal");
    const id = await lastPty(app);
    await app.emit(`pty-data-${id}`, b64("see https://grafana.example.com/d/abc for details.\r\n"));
    const link = page.locator(".term-host:not([hidden]) .xterm-rows span", { hasText: "grafana.example.com" }).first();
    await expect(link).toBeVisible();
    await link.click({ modifiers: ["Control"] });
    // точка в конце предложения в адрес не входит
    expect((await app.called("open_external")).args).toEqual({ url: "https://grafana.example.com/d/abc" });
  });
});
