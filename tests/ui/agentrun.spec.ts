import { test, expect } from "./fixtures";

const POLICY = { enabled: true, mode: "read", hosts: {}, allow_sudo: false, allow_local: false, max_steps: 12, step_timeout_s: 20, output_limit: 4000, extra_read: [], always_ask: [], deny: [], model: { source: "app", host: "", port: "", name: "" } };

const steps = (page: import("@playwright/test").Page, answers: string[]) =>
  page.evaluate((a) => { (window as any).__DEMO_AGENT_STEPS = a; }, answers);

const openAgentChat = async (app: { view: (id: string) => Promise<void> }, page: import("@playwright/test").Page) => {
  await app.view("terminal");
  await page.locator("[data-act=ai]").click();
  await page.locator(".ai-provider").selectOption("OpsDeck AI (локальный)");
  await expect(page.locator(".ai-chat")).toBeVisible();
  await page.locator(".ai-agent-mode input").check();
};

test.describe("расследование в AI-панели", () => {
  test.use({ demo: { overrides: { agent_policy: POLICY } } });

  test("агент идёт на хост, показывает команду и её вывод, а потом итог", async ({ app, page }) => {
    await openAgentChat(app, page);
    await steps(page, ["ХОСТ: app-1\nКОМАНДА: lsblk -f", "ГОТОВО: данные лежат на vg-data, 200 ГБ"]);

    await page.locator(".ai-chat textarea").fill("сходи на app-1 и посмотри что на lvm");
    await page.keyboard.press("Enter");

    const step = page.locator(".ai-step").first();
    await expect(step).toContainText("app-1");
    await expect(step).toContainText("lsblk -f");
    // команда ушла на выполнение по ключу хоста, а не по имени
    expect((await app.called("agent_exec")).args).toMatchObject({ target: "id:h3", command: "lsblk -f", approved: false });
    await expect(page.locator(".ai-out")).toContainText("вывод");
    await page.locator(".ai-out summary").click();
    await expect(page.locator(".ai-out pre")).toContainText("/srv/data");
    await expect(page.locator(".ai-done")).toContainText("vg-data");
  });

  test("изменяющая команда ждёт разрешения, и без него не выполняется", async ({ app, page }) => {
    await openAgentChat(app, page);
    await steps(page, ["ХОСТ: app-1\nКОМАНДА: systemctl restart api", "ГОТОВО: хорошо, не трогаю"]);
    await app.override("agent_check", { verdict: { kind: "write" }, mode: "ask", allowed_now: false, needs_approval: true, why: "нужно разрешение администратора" });

    await page.locator(".ai-chat textarea").fill("перезапусти api на app-1");
    await page.keyboard.press("Enter");

    const dlg = page.locator("dialog.ask");
    await expect(dlg).toContainText("systemctl restart api");
    await expect(dlg).toContainText("app-1");
    await dlg.locator("button[value=cancel]").click();

    await expect(page.locator(".ai-msg.agent")).toContainText("не разрешил");
    expect(await app.calls("agent_exec")).toHaveLength(0);
  });

  test("без включённого агента режим расследования даже не предлагается", async ({ app, page }) => {
    await app.override("agent_policy", { ...POLICY, enabled: false });
    await app.view("terminal");
    await page.locator("[data-act=ai]").click();
    await page.locator(".ai-provider").selectOption("OpsDeck AI (локальный)");
    await expect(page.locator(".ai-agent-mode")).toBeHidden();
  });
});
