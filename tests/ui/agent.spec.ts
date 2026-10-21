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

  test("на экране написано, что делает каждый уровень, и какой выбран сейчас", async ({ page }) => {
    const levels = page.locator(".agent-levels li");
    await expect(levels).toHaveCount(4);
    await expect(levels.filter({ hasText: "Только чтение" })).toContainText("разрешением это не обходится");
    await expect(levels.filter({ hasText: "Менять с разрешения" })).toContainText("ждёт нажатия");
    // выбранный уровень подсвечен, и подсветка переезжает вместе с выбором
    await expect(page.locator(".agent-levels li.now")).toContainText("Только чтение");
    await page.locator("[data-a=mode]").selectOption("trusted");
    await expect(page.locator(".agent-levels li.now")).toContainText("Менять без вопросов");
    // то, что не выполнится ни при каком уровне, написано рядом
    await expect(page.locator(".agent-card").first()).toContainText("не выполнятся никогда");
  });

  test("правила пишутся по строкам или через запятую и сохраняются как есть", async ({ app, page }) => {
    await page.locator("[data-a=deny]").fill("docker system prune, | bash\n  kubectl   delete  ");
    await page.locator("[data-a=deny]").dispatchEvent("change");
    expect((await saved(app)).deny).toEqual(["docker system prune", "| bash", "kubectl delete"]);
    await page.locator("[data-a=always_ask]").fill("kubectl get secret");
    await page.locator("[data-a=always_ask]").dispatchEvent("change");
    expect((await saved(app)).always_ask).toEqual(["kubectl get secret"]);
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

    // своё правило видно по имени: откуда отказ, гадать не надо
    await page.locator("[data-a=deny]").fill("docker system prune");
    await page.locator("[data-a=deny]").dispatchEvent("change");
    await page.locator(".agent-try-cmd").fill("docker system prune -a --volumes");
    await page.locator("[data-a=try]").click();
    await expect(out).toContainText("запрещено вашим правилом «docker system prune»");

    // проверка — это разбор, а не запуск
    expect(await app.calls("agent_exec")).toHaveLength(0);
  });

  test("модель агента: по умолчанию общая, и про слабую сказано прямо", async ({ app, page }) => {
    const note = page.locator(".agent-brain-note");
    await expect(note).toContainText("Как в настройках");
    await expect(note).toContainText("слабовата");
    await expect(note).toHaveClass(/warn/);
    await expect(page.locator(".agent-server")).toBeHidden();
  });

  test("свой сервер для агента: поля появляются, и без них видно, чего не хватает", async ({ app, page }) => {
    await page.locator("[data-a=model_source]").selectOption("server");
    await expect(page.locator(".agent-server")).toBeVisible();
    expect((await saved(app)).model).toMatchObject({ source: "server" });
    await expect(page.locator(".agent-brain-note")).toContainText("не указан адрес сервера");
    await expect(page.locator(".agent-brain-note")).toHaveClass(/err/);

    await page.locator("[data-a=model_host]").fill("ollama.example.com");
    await page.locator("[data-a=model_host]").dispatchEvent("change");
    await expect(page.locator(".agent-brain-note")).toContainText("не указано имя модели");

    await page.locator("[data-a=model_name]").fill("qwen2.5-coder:14b");
    await page.locator("[data-a=model_name]").dispatchEvent("change");
    const note = page.locator(".agent-brain-note");
    await expect(note).toContainText("qwen2.5-coder:14b");
    await expect(note).toHaveClass(/ok/);
    expect((await saved(app)).model).toMatchObject({ source: "server", host: "ollama.example.com", name: "qwen2.5-coder:14b" });
  });

  test("длинный список правил берётся из файла и дополняет уже введённое", async ({ app, page }) => {
    await page.locator("[data-a=deny]").fill("rm -rf");
    await page.locator("[data-a=deny]").dispatchEvent("change");
    await page.locator("[data-file=deny]").click();
    await expect(page.locator(".rule-count[data-for=deny]")).toHaveText("правил: 4");
    expect((await saved(app)).deny).toEqual(["rm -rf", "docker system prune", "kubectl delete", "| bash"]);
    // показываем через запятую — так же, как удобно вставлять
    await expect(page.locator("[data-a=deny]")).toHaveValue("rm -rf, docker system prune, kubectl delete, | bash");
    await expect(page.locator(".toast").last()).toContainText("Правил добавлено: 3");
  });

  // из отчёта: хост добавили в разделе SSH, а здесь он появлялся только после перезапуска
  test("хост, добавленный в разделе SSH, виден сразу при возврате в раздел", async ({ app, page }) => {
    const before = await page.locator(".agent-host").count();
    await app.override("ssh_list", {
      hosts: [{ id: "new1", name: "zeta-new", group: "prod", host: "198.51.100.99", port: 22, user: "ops", identity_file: "", jump: "", auth: "key", keepass_entry: "" }],
      config: [],
    });
    await app.view("ssh");
    await app.view("agent");
    await expect(page.locator(".agent-host")).toHaveCount(1);
    expect(before).toBeGreaterThan(1);
    await expect(page.locator(".agent-host").first()).toContainText("zeta-new");
    // и в проверке команды он тоже есть
    await expect(page.locator(".agent-try-host option")).toContainText(["эта машина", "zeta-new"]);
  });

  test("журнал показывает, что агент уже делал", async ({ page }) => {
    const rows = page.locator(".agent-log tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("journalctl -u nginx");
    await expect(rows.nth(1)).toContainText("с разрешения");
  });
});
