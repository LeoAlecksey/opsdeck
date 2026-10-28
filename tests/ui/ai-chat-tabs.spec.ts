import { test, expect } from "./fixtures";

// #97 — вкладки чата локального ИИ и привязка к вкладке терминала или серверу;
// #100 — история чата между запусками.
const LOCAL = "OpsDeck AI (локальный)";
const POLICY = { enabled: true, mode: "read", hosts: {}, allow_sudo: false, allow_local: false, max_steps: 12, step_timeout_s: 20, output_limit: 4000, extra_read: [], always_ask: [], deny: [], model: { source: "app", host: "", port: "", name: "" } };

type Page = import("@playwright/test").Page;
const openChat = async (app: { view: (id: string) => Promise<void> }, page: Page) => {
  await app.view("terminal");
  await page.locator("[data-act=ai]").click();
  await page.selectOption(".ai-provider", LOCAL);
  await expect(page.locator(".ai-chat")).toBeVisible();
};
const ctabs = (page: Page) => page.locator(".ai-ctab");
const visibleLog = (page: Page) => page.locator(".ai-chat-log:not([hidden])");
const askChat = async (page: Page, q: string) => {
  await page.locator(".ai-chat textarea").fill(q);
  await page.locator(".ai-chat textarea").press("Enter");
  await expect(page.locator("[data-c=send]")).toHaveText("Отправить");
};

test.describe("AI chat tabs (#97)", () => {
  test("each tab has its own conversation; the title comes from the first question; closing keeps the others", async ({ app, page }) => {
    await openChat(app, page);
    await expect(ctabs(page)).toHaveCount(1);
    await askChat(page, "почему поды перезапускаются?");
    await expect(ctabs(page).first()).toContainText("почему поды перезапускаются?");

    await page.locator("[data-c=tab-new]").click();
    await expect(ctabs(page)).toHaveCount(2);
    await expect(ctabs(page).nth(1)).toHaveClass(/cur/);
    await expect(visibleLog(page).locator(".ai-msg")).toHaveCount(0);
    await askChat(page, "как посмотреть порты?");
    // вторая вкладка не тащит в модель разговор первой
    expect(((await app.calls("ai_chat")).at(-1)!.args as any).messages).toEqual([{ role: "user", content: "как посмотреть порты?" }]);

    await ctabs(page).first().click();
    await expect(visibleLog(page).locator(".ai-msg.user")).toHaveText(["почему поды перезапускаются?"]);
    // вопрос в первой вкладке продолжает её разговор
    await askChat(page, "а дальше?");
    expect(((await app.calls("ai_chat")).at(-1)!.args as any).messages.map((m: any) => m.content)[0]).toBe("почему поды перезапускаются?");

    // двойной клик — переименовать
    await ctabs(page).first().dblclick();
    await page.locator("dialog.ask input").fill("поды shop");
    await page.locator("dialog.ask button.primary").click();
    await expect(ctabs(page).first()).toContainText("поды shop");

    await ctabs(page).nth(1).locator("[data-c=tab-close]").click();
    await expect(ctabs(page)).toHaveCount(1);
    await expect(visibleLog(page).locator(".ai-msg.user").first()).toHaveText("почему поды перезапускаются?");
    // последнюю вкладку крестик не убирает, а начинает заново
    await ctabs(page).first().locator("[data-c=tab-close]").click();
    await expect(ctabs(page)).toHaveCount(1);
    await expect(visibleLog(page).locator(".ai-msg")).toHaveCount(0);
  });

  test("no more than 8 tabs", async ({ app, page }) => {
    await openChat(app, page);
    for (let i = 0; i < 7; i++) await page.locator("[data-c=tab-new]").click();
    await expect(ctabs(page)).toHaveCount(8);
    await page.locator("[data-c=tab-new]").click();
    await expect(page.locator(".toast").last()).toContainText("Не больше 8 вкладок чата");
    await expect(ctabs(page)).toHaveCount(8);
  });

  test("bound to a terminal tab: its context, commands go there, and switching to it opens the chat tab", async ({ app, page }) => {
    await openChat(app, page);
    // вторая вкладка терминала; чат привязываем к первой
    await page.locator("[data-act=new]").click();
    await expect(page.locator(".tabs .tab")).toHaveCount(2);
    const first = (await page.locator(".tabs .tab .label").first().textContent())!;
    await page.locator(".ai-bind").selectOption({ label: first });
    await expect(ctabs(page).first()).toHaveClass(/bound/);
    await page.locator("[data-c=tab-new]").click(); // вторая вкладка чата — без привязки

    // переход на первую вкладку терминала открывает привязанную вкладку чата
    await page.locator(".tabs .tab").first().click();
    await expect(ctabs(page).first()).toHaveClass(/cur/);
    // вторая вкладка терминала активна, а команда всё равно уходит в первую — и та открывается
    await page.locator(".tabs .tab").nth(1).click();
    await expect(ctabs(page).first()).toHaveClass(/cur/); // к второй ничего не привязано — чат не прыгает
    await askChat(page, "почему поды перезапускаются?");
    const writes = (await app.calls("pty_write")).length;
    await visibleLog(page).locator(".ai-msg.assistant [data-c=insert]").first().click();
    await expect(page.locator(".tabs .tab").first()).toHaveClass(/active/);
    await expect.poll(async () => (await app.calls("pty_write")).slice(writes).map((c) => (c.args as any).data).join("")).toContain("kubectl get pods -A");

    // вкладку терминала закрыли — привязка снята, в разговоре об этом сказано
    await page.locator(".tabs .tab").first().locator(".x").click();
    await expect(ctabs(page).first()).not.toHaveClass(/bound/);
    await expect(page.locator(".ai-chat-note")).toContainText("закрыта — привязка снята");
  });

  test.describe("bound to a server", () => {
    test.use({ demo: { overrides: { agent_policy: POLICY } } });

    test("the model is told the server; an investigation gets only that host", async ({ app, page }) => {
      await openChat(app, page);
      await page.locator(".ai-bind").selectOption({ label: "app-1" });
      await askChat(page, "почему не стартует nginx?");
      expect(((await app.calls("ai_chat")).at(-1)!.args as any).server).toBe("app-1");

      await page.evaluate(() => { (window as any).__DEMO_AGENT_STEPS = ["ГОТОВО: на app-1 всё в порядке"]; });
      await page.locator(".ai-agent-mode input").check();
      await askChat(page, "посмотри диск");
      await expect(visibleLog(page).locator(".ai-done")).toContainText("всё в порядке");
      const step = (await app.calls("ai_chat")).at(-1)!.args as any;
      expect(step.hosts).toEqual(["app-1"]);
    });
  });
});

test.describe("AI chat history (#100)", () => {
  test("tabs, conversations and server bindings are saved; a terminal-tab binding is not", async ({ app, page }) => {
    await openChat(app, page);
    await askChat(page, "почему поды перезапускаются?");
    await page.locator("[data-c=tab-new]").click();
    await page.locator(".ai-bind").selectOption({ label: "db-primary" });
    await page.locator("[data-c=tab-new]").click();
    await page.locator(".ai-bind").selectOption({ index: 1 }); // первая вкладка терминала
    await expect.poll(async () => {
      const c = (await app.calls("ai_chat_history_save")).at(-1)?.args as any;
      return c?.chats?.tabs?.length;
    }).toBe(3);
    const saved = ((await app.calls("ai_chat_history_save")).at(-1)!.args as any).chats;
    expect(saved.tabs[0].entries.map((e: any) => e.role)).toEqual(["user", "assistant"]);
    expect(saved.tabs[0].title).toBe("почему поды перезапускаются?");
    expect(saved.tabs[1].server).toEqual({ key: "id:h2", name: "db-primary" });
    expect(saved.tabs[2].server).toBeNull();
    expect(saved.current).toBe(saved.tabs[2].id);
  });

  test.describe("after a restart", () => {
    test.use({ demo: { overrides: { agent_policy: POLICY, ai_chat_history_load: {
      current: "c2",
      tabs: [
        { id: "c1", title: "поды shop", named: true, server: null, entries: [
          { role: "user", content: "почему поды перезапускаются?", agent: false },
          { role: "assistant", content: "Посмотрите:\n\n```bash\nkubectl get pods -n shop\n```", agent: false },
        ] },
        { id: "c2", title: "диск app-1", named: false, server: { key: "id:h3", name: "app-1" }, entries: [
          { role: "user", content: "посмотри диск", agent: true },
          { role: "assistant", content: "на app-1 занято 91% /var", agent: true },
        ] },
      ],
    } } } });

    test("the conversations are back, investigations are not sent to the model again", async ({ app, page }) => {
      await openChat(app, page);
      await expect(ctabs(page)).toHaveCount(2);
      await expect(ctabs(page).nth(1)).toHaveClass(/cur/);
      await expect(ctabs(page).nth(1)).toHaveClass(/bound/);
      await expect(page.locator(".ai-bind")).toHaveValue("server:id:h3");
      await expect(visibleLog(page).locator(".ai-msg.agent")).toContainText("занято 91%");
      await expect(visibleLog(page).locator(".ai-msg.agent")).toContainText("шаги и вывод команд не сохраняются");
      // итог расследования виден, но в следующий вопрос модели не идёт
      await askChat(page, "что почистить?");
      expect(((await app.calls("ai_chat")).at(-1)!.args as any).messages).toEqual([{ role: "user", content: "что почистить?" }]);

      await ctabs(page).first().click();
      await expect(visibleLog(page).locator(".ai-code code")).toHaveText("kubectl get pods -n shop");
      await askChat(page, "а логи?");
      expect(((await app.calls("ai_chat")).at(-1)!.args as any).messages).toHaveLength(3);
    });

    test("turning it off deletes what was saved and stops saving; «delete» also clears the open chat", async ({ app, page }) => {
      await openChat(app, page);
      await expect(ctabs(page)).toHaveCount(2);
      await app.view("settings");
      await expect(page.locator(".ai-chat-keep")).toBeChecked();
      await page.locator(".ai-chat-keep").uncheck();
      await app.called("ai_chat_history_clear");
      await app.view("terminal");
      const saves = (await app.calls("ai_chat_history_save")).length;
      await askChat(page, "ещё вопрос");
      await page.waitForTimeout(800);
      expect(await app.calls("ai_chat_history_save")).toHaveLength(saves);

      await app.view("settings");
      await page.locator("[data-a=ai-chat-forget]").click();
      await page.locator("dialog.ask button.danger-solid").click();
      await expect(page.locator(".toast").last()).toContainText("История чата удалена");
      await app.view("terminal");
      await expect(ctabs(page)).toHaveCount(1);
      await expect(visibleLog(page).locator(".ai-msg")).toHaveCount(0);
    });
  });
});
