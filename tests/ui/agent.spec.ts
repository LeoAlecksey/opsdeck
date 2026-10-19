import { test, expect } from "./fixtures";

const saved = async (app: { calls: (c?: string) => Promise<{ args: Record<string, unknown> }[]> }) =>
  ((await app.calls("agent_policy_save")).at(-1)!.args as { policy: Record<string, unknown> }).policy;

test.describe("ИИ-агент: правила", () => {
  test.beforeEach(async ({ app }) => { await app.view("agent"); });

  test("пока общий выключатель выключен, это видно по разделу", async ({ app, page }) => {
    await expect(page.locator(".agent")).toHaveClass(/off/);
    await page.locator("[data-a=enabled]").check();
    expect(await saved(app)).toMatchObject({ enabled: true, mode: "read", allow_sudo: false, allow_local: false });
    await expect(page.locator(".agent")).not.toHaveClass(/off/);
  });

  test("уровень доступа объясняется словами, а не названием", async ({ page }) => {
    await expect(page.locator(".mode-hint")).toHaveText("смотрит логи и состояние; изменить ничего не может");
    await page.locator("[data-a=mode]").selectOption("trusted");
    await expect(page.locator(".mode-hint")).toContainText("только для хостов, которые не жалко");
  });

  test("у хоста свой уровень, и он сохраняется отдельно от общего", async ({ app, page }) => {
    const host = page.locator(".agent-host select").first();
    await expect(page.locator(".agent-host")).not.toHaveCount(0);
    const key = await page.locator(".agent-host select").first().getAttribute("data-host");
    await host.selectOption("ask");
    expect((await saved(app)).hosts).toEqual({ [key!]: "ask" });
    // «как по умолчанию» убирает хост из списка исключений
    await host.selectOption("");
    expect((await saved(app)).hosts).toEqual({});
  });

  test("свои списки разбираются по пробелам, без пустых значений", async ({ app, page }) => {
    await page.locator("[data-a=deny]").fill("  journalctl   docker  journalctl ");
    await page.locator("[data-a=deny]").dispatchEvent("change");
    expect((await saved(app)).deny).toEqual(["journalctl", "docker"]);
  });

  test("проверка команды показывает, что будет, и ничего не выполняет", async ({ app, page }) => {
    const out = page.locator(".agent-try-out");
    await page.locator(".agent-try-cmd").fill("journalctl -u nginx");
    await page.locator("[data-a=try]").click();
    await expect(out).toHaveText("чтение — выполнит сам");
    await expect(out).toHaveClass(/ok/);

    await page.locator(".agent-try-cmd").fill("systemctl restart nginx");
    await page.locator("[data-a=try]").click();
    await expect(out).toHaveText("изменение — спросит разрешения");
    await expect(out).toHaveClass(/warn/);

    await page.locator(".agent-try-cmd").fill("rm -rf /var/log");
    await page.locator("[data-a=try]").click();
    await expect(out).toContainText("не выполнится");
    await expect(out).toHaveClass(/err/);

    // проверка — это разбор, а не запуск
    expect(await app.calls("agent_exec")).toHaveLength(0);
  });

  test("журнал показывает, что агент уже делал", async ({ page }) => {
    const rows = page.locator(".agent-log tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("journalctl -u nginx");
    await expect(rows.nth(1)).toContainText("с разрешения");
  });
});
