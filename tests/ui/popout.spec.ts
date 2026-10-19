import { test, expect } from "./fixtures";

test.describe("раздел в отдельном окне", () => {
  test("кнопка в полосе вкладок терминала открывает окно с терминалом", async ({ app, page }) => {
    await app.view("terminal");
    await page.locator("[data-act=popout]").click();
    expect((await app.called("window_popout")).args).toEqual({ view: "terminal" });
  });

  test("правый клик по иконке модуля предлагает вынести его; у веб-панелей такого нет", async ({ app, page }) => {
    await page.locator("#sidebar button[data-view=k8s]").click({ button: "right" });
    await page.locator(".view-menu [data-pop=k8s]").click();
    expect((await app.called("window_popout")).args).toEqual({ view: "k8s" });
    await expect(page.locator(".view-menu")).toHaveCount(0);

    // Grafana/ArgoCD/GitLab — нативные webview главного окна, их выносить нельзя
    await page.locator("#sidebar button[data-view=web]").click({ button: "right" });
    await expect(page.locator(".view-menu")).toHaveCount(0);
  });

  test("палитра команд: раздел выносится и оттуда", async ({ app, page }) => {
    await page.keyboard.press("Control+Shift+P");
    await page.locator(".palette input").fill("отдельное окно");
    await expect(page.locator(".palette-item", { hasText: "Файлы на хостах" })).toBeVisible();
    await page.locator(".palette-item", { hasText: "Файлы на хостах" }).first().click();
    expect((await app.called("window_popout")).args).toEqual({ view: "sftp" });
  });
});

test.describe("вынесенное окно", () => {
  test.use({ demo: { win: "pop-terminal" } });

  test("показывает только свой раздел, без боковой колонки", async ({ app, page }) => {
    await expect(page.locator("#sidebar")).toBeHidden();
    await expect(page.locator(".terminal-view")).toBeVisible();
    await expect(page.locator("#views .view")).toHaveCount(1);
    // выносить окно из себя же некуда
    await expect(page.locator("[data-act=popout]")).toBeHidden();
    // набор модулей главного окна остался как был: окно его не переписывает
    expect(await page.evaluate(() => localStorage.getItem("opsdeck.modules"))).toContain("k8s");
    // здесь свой терминал, а не чужая сессия: имя сессии с меткой окна
    expect((await app.called("pty_spawn")).args).toMatchObject({ req: { id: "pty-pop-terminal-1" } });
  });

  test("не проверяет обновления и не держит счётчик алертов — это дело главного окна", async ({ app }) => {
    expect(await app.calls("alerts_get")).toHaveLength(0);
    expect(await app.calls("settings_get")).toHaveLength(0);
  });

  test("раздел, которого здесь нет, открывается в главном окне", async ({ app, page }) => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: "/srv/app/main.rs" } })));
    await app.called("window_focus_main");
    // IDE в этом окне не монтируется
    await expect(page.locator(".code-view")).toHaveCount(0);
  });
});
