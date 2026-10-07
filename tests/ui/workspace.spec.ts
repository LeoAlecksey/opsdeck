import { test, expect } from "./fixtures";

const view = (page: import("@playwright/test").Page) => page.locator("section.view:not([hidden])");

test.describe("notes", () => {
  test.beforeEach(async ({ app, page }) => {
    await app.view("notes");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-note", { detail: { path: (window as any).__DEMO_NOTE } })));
    await expect(page.locator(".note-view")).toContainText("Перезапуск воркера shop");
  });

  test("add a tag: it goes to the front matter and the note is saved", async ({ app, page }) => {
    await expect(page.locator(".note-tags")).toContainText("#runbook");
    await page.locator(".tag-in").fill("oncall");
    await page.locator(".tag-in").press("Enter");
    const w = await app.called("note_write");
    expect(w.args.path).toBe("runbooks/Перезапуск воркера.md");
    expect(w.args.content as string).toMatch(/^---\ntags: \[runbook, shop, oncall\]\n---\n/);
  });

  test("editor mode and Ctrl+S", async ({ app, page }) => {
    await page.locator("[data-m=edit]").click();
    const editor = page.locator(".note-editor");
    await expect(editor).toBeVisible();
    await editor.press("End");
    await editor.pressSequentially("\nНовая строка");
    await page.keyboard.press("Control+KeyS");
    expect((await app.called("note_write")).args.content as string).toContain("Новая строка");
  });

  test("the vault menu lists vaults", async ({ page }) => {
    await page.locator(".vault-btn").click();
    await expect(page.locator(".vault-menu")).toContainText("work");
  });
});

test.describe("tasks", () => {
  test.beforeEach(async ({ app }) => { await app.view("tasks"); });

  test("grouped by due date, with the badge for overdue + today", async ({ page }) => {
    await expect(page.locator('#sidebar button[data-view="tasks"]')).toHaveAttribute("data-badge", "3");
    await expect(view(page)).toContainText("Просрочено");
    await expect(view(page)).toContainText("Сегодня");
    await expect(page.locator(".tk-check:not(:checked)")).toHaveCount(7);
  });

  test("done and → tomorrow update the line in the note", async ({ app, page }) => {
    const row = page.locator(".tk-row", { hasText: "Обновить сертификат shop.example.com" });
    await row.locator(".tk-check").click();
    expect((await app.called("task_update")).args).toMatchObject({ path: "Задачи.md", line: 3, change: { done: true } });
    const row2 = page.locator(".tk-row", { hasText: "Почистить старые образы" });
    await row2.hover();
    await row2.locator("[data-act=tomorrow]").click();
    await expect.poll(async () => (await app.calls("task_update")).length).toBe(2);
  });

  test("calendar", async ({ page }) => {
    await page.locator("[data-a=cal]").click();
    await expect(page.locator(".cal-grid")).toBeVisible();
    await expect(page.locator(".cal-day.today")).toContainText("Обновить сертификат");
  });
});

test.describe("databases", () => {
  test("structure, double click a table, Ctrl+Enter", async ({ app, page }) => {
    await app.view("db");
    await page.locator('.db-conn[data-id="d1"] > .tree-row').click();
    await expect(page.locator(".db-ro")).toBeVisible();
    await page.locator(".tree-dir[data-id='d1'] .tree-row", { hasText: "public" }).click();
    await page.locator(".db-leaf[data-id='d1']", { hasText: "orders" }).dblclick();
    expect((await app.called("db_query")).args).toMatchObject({ id: "d1", query: "SELECT * FROM public.orders LIMIT 100;" });
    await expect(page.locator(".db-table tbody tr")).toHaveCount(8);
    await page.locator(".db-editor").fill("SELECT count(*) FROM orders;");
    await page.locator(".db-editor").press("Control+Enter");
    await expect.poll(async () => (await app.calls("db_query")).at(-1)?.args.query).toBe("SELECT count(*) FROM orders;");
  });
});

test.describe("IDE", () => {
  test("project tree, terraform file, git panel, save", async ({ app, page }) => {
    await app.view("code");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: "/home/demo/projects/infra" } })));
    await expect(view(page)).toContainText("main.tf");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: "/home/demo/projects/infra/main.tf", line: 18 } })));
    await expect(page.locator(".cm-content")).toContainText('module "cluster"');
    await page.locator("[data-a=git-toggle]").click();
    await expect(view(page)).toContainText("feature/monitoring");
    await expect(page.locator(".cg-commit")).toHaveCount(8);
    await page.locator(".cm-content").click();
    await page.keyboard.type("# changed\n");
    await page.keyboard.press("Control+KeyS");
    await app.called("code_write");
  });
});

test.describe("settings", () => {
  test.beforeEach(async ({ app }) => { await app.view("settings"); });

  test("local AI: model, acceleration, external server warning", async ({ app, page }) => {
    await page.locator(".ai-model").selectOption("qwen3.5-4b");
    expect((await app.called("ai_select")).args).toEqual({ model: "qwen3.5-4b" });
    await page.locator(".ai-gpu").selectOption("cpu");
    expect((await app.called("ai_set_gpu")).args).toEqual({ on: false });
    await page.locator("input[name=ai_host]").fill("192.0.2.80");
    await page.locator("input[name=ai_model]").fill("qwen3:8b");
    await expect(page.locator(".ai-remote-warn")).toContainText("уходят на сервер http://192.0.2.80:11434");
    await expect(page.locator(".ai-remote-warn")).toContainText("без шифрования");
    await page.locator("input[name=ai_host]").fill("localhost");
    await expect(page.locator(".ai-remote-warn")).toContainText("на этом компьютере");
  });

  test("save sends a new API key once and never shows it back", async ({ app, page }) => {
    await page.locator("input[name=ai_api_key]").fill("sk-demo");
    await view(page).locator("button[type=submit]", { hasText: "Сохранить" }).click();
    const set = await app.called("settings_set");
    expect((set.args as any).settings.ai_api_key).toBe("sk-demo");
    await expect(page.locator("input[name=ai_api_key]")).toHaveValue("");
  });

  test("terminal font picker", async ({ page }) => {
    await page.locator(".term-font-family").selectOption("Ubuntu Mono");
    expect(await page.evaluate(() => localStorage.getItem("opsdeck.term.fontFamily"))).toBe("Ubuntu Mono");
    await page.locator(".term-font-family").selectOption("__other__");
    await expect(page.locator(".term-font-custom-row")).toBeVisible();
  });
});

test.describe("other sections", () => {
  test("web panels open as tabs", async ({ app, page }) => {
    await app.view("web");
    await expect(page.locator(".card-name")).toHaveCount(3);
    await page.locator(".card", { hasText: "Grafana" }).locator("[data-act=open]").click();
    await app.called("web_embed_show");
  });

  test("network tools run without a shell", async ({ app, page }) => {
    await app.view("net");
    await page.locator("input[name=target]").fill("example.com");
    await page.locator("[data-pane=tools] button[type=submit]").click();
    const run = await app.called("tool_run");
    expect((run.args as any).req).toMatchObject({ tool: "ping", target: "example.com", count: 4 });
  });

  test("MikroTik: WinBox in one click", async ({ app, page }) => {
    await app.view("winbox");
    await page.locator("[data-a=winbox]").click();
    expect((await app.called("mt_winbox")).args).toEqual({ id: "m1" });
  });
});
