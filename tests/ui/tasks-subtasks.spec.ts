import { test, expect } from "./fixtures";

// Раздел «Задачи»: описание и подзадачи — строки с отступом под задачей, как в Obsidian.
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const T = (line: number, text: string, extra: Record<string, unknown> = {}) => ({
  path: "Задачи.md", line, raw: `- [ ] ${text}`, text, done: false, due: null, time: null, priority: 0, tags: [], done_date: null, parent: null, desc: "", ...extra,
});
const TASKS = [
  T(3, "Обновить сертификат на ingress", { due: today, raw: `- [ ] Обновить сертификат на ingress 📅 ${today}`, desc: "Выпускали через certbot.\n```bash\nnginx -t && systemctl reload nginx\n```\nСм. `ранбук`." }),
  T(7, "проверить срок", { parent: 3, done: true, raw: "    - [x] проверить срок", done_date: today }),
  T(8, "выпустить сертификат", { parent: 3, raw: "    - [ ] выпустить сертификат", desc: "только на bastion" }),
  T(10, "положить в secret", { parent: 8, raw: "        - [ ] положить в secret" }),
  T(12, "Почистить registry"),
];

test.describe("task descriptions and subtasks", () => {
  test.use({ demo: { overrides: { tasks_list: TASKS, task_format: "- [ ] проверить снаружи" } } });
  test.beforeEach(async ({ app }) => { await app.view("tasks"); });

  const row = (page: import("@playwright/test").Page, text: string) => page.locator(".tk-row", { hasText: text }).first();

  test("subtasks are under their task, not in the groups; ☑ shows how many are done", async ({ page }) => {
    await expect(page.locator(".tk-list > .tk-group .tk-items > .tk-row")).toHaveCount(2);
    const parent = row(page, "Обновить сертификат на ingress");
    await expect(parent.locator(".tk-progress")).toHaveText("☑ 1/3");
    await expect(parent.locator(".tk-hasdesc")).toHaveCount(1);
    await expect(page.locator(".tk-row", { hasText: "выпустить сертификат" })).toHaveCount(0);

    await parent.locator("[data-act=expand]").click();
    const details = page.locator(".tk-details").first();
    await expect(details.locator(".tk-desc")).toContainText("Выпускали через certbot.");
    await expect(details.locator(".tk-desc .tk-code")).toHaveText("nginx -t && systemctl reload nginx");
    await expect(details.locator(".tk-desc code").last()).toHaveText("ранбук");
    await expect(details.locator(".tk-subs > .tk-row")).toHaveCount(2);
    await expect(details.locator(".tk-subs > .tk-row.done")).toContainText("проверить срок");
    // подзадача раскрывается так же — со своим описанием и подзадачами
    await row(page, "выпустить сертификат").locator(".tk-text").click();
    await expect(page.locator(".tk-details .tk-details")).toContainText("только на bastion");
    await expect(page.locator(".tk-details .tk-details")).toContainText("положить в secret");
  });

  test("the description is edited in place and saved by Ctrl+Enter", async ({ app, page }) => {
    await row(page, "Почистить registry").locator("[data-act=expand]").click();
    await page.locator(".tk-desc.empty").click();
    const box = page.locator(".tk-desc-in");
    await box.fill("старше 30 дней\nкроме тегов release-*");
    await box.press("Control+Enter");
    expect((await app.called("task_describe")).args).toEqual({ path: "Задачи.md", line: 12, raw: "- [ ] Почистить registry", desc: "старше 30 дней\nкроме тегов release-*" });
    await expect(page.locator(".toast").last()).toContainText("Описание сохранено");
  });

  test("a subtask is added with Enter at the end of the task's block, the field stays for the next one", async ({ app, page }) => {
    await row(page, "Обновить сертификат на ingress").locator("[data-act=expand]").click();
    const input = page.locator(".tk-details .tk-sub-in").first();
    await input.fill("проверить снаружи");
    await input.press("Enter");
    expect((await app.called("task_format")).args).toMatchObject({ text: "проверить снаружи", due: null });
    expect((await app.called("task_add_sub")).args).toEqual({ path: "Задачи.md", line: 3, raw: `- [ ] Обновить сертификат на ingress 📅 ${today}`, task: "- [ ] проверить снаружи" });
    // задача остаётся раскрытой после перечитывания, поле снова в фокусе
    await expect(page.locator(".tk-details .tk-sub-in").first()).toBeFocused();
  });

  test("search finds a task by its subtask; deleting warns that subtasks and description go too", async ({ page }) => {
    await page.locator(".tk-filter").fill("положить в secret");
    await expect(page.locator(".tk-list > .tk-group .tk-items > .tk-row")).toHaveCount(1);
    await expect(page.locator(".tk-list > .tk-group .tk-items > .tk-row")).toContainText("Обновить сертификат на ingress");
    await page.locator(".tk-filter").fill("");
    const parent = row(page, "Обновить сертификат на ingress");
    await parent.hover();
    await parent.locator("[data-act=del]").click();
    await expect(page.locator("dialog.ask")).toContainText("Вместе с ней удалятся подзадачи (3) и описание");
    await page.locator("dialog.ask button[value=cancel]").click();
  });

  test("the task dialog has a description: a new task gets it, an edited one changes it", async ({ app, page }) => {
    await page.locator(".tasks-page [data-a=add]").click();
    const dlg = page.locator("dialog.task-dialog");
    await dlg.locator("[name=text]").fill("проверить снаружи");
    await dlg.locator("[name=desc]").fill("curl -vI https://shop.example.com");
    await dlg.locator("button.primary").click();
    expect((await app.called("task_add")).args).toMatchObject({ line: "- [ ] проверить снаружи", desc: "curl -vI https://shop.example.com" });

    // правка: строка задачи меняется, описание пишется уже по новой строке
    await app.override("task_update", { ...TASKS[4], raw: "- [ ] Почистить registry 🔼" });
    const r = row(page, "Почистить registry");
    await r.hover();
    await r.locator("[data-act=edit]").click();
    await expect(dlg.locator("[name=desc]")).toHaveValue("");
    await dlg.locator("[name=desc]").fill("только старые теги");
    await dlg.locator("button.primary").click();
    expect((await app.called("task_describe")).args).toEqual({ path: "Задачи.md", line: 12, raw: "- [ ] Почистить registry 🔼", desc: "только старые теги" });
  });
});
