import { test, expect } from "./fixtures";

test.describe("Yandex Cloud", () => {
  test.beforeEach(async ({ app }) => { await app.view("yc"); });

  test("instances show their state, configuration and addresses; SSH opens a tab", async ({ app, page }) => {
    expect((await app.called("yc_instances")).args).toEqual({ folderId: "b1gf1" });
    const rows = page.locator(".yc-body tbody tr");
    await expect(rows).toHaveCount(6);
    const app1 = rows.filter({ hasText: "app-1" });
    await expect(app1).toContainText("RUNNING");
    // доля ядра и «прерываемая» видны: за это и платят
    await expect(app1).toContainText("standard-v3 · 2 vCPU (20%) · 4.0 GB · прерываемая");
    await expect(app1).toContainText("203.0.113.7");
    await expect(rows.filter({ hasText: "db-1" })).toContainText("STOPPED");

    await app1.locator("[data-a=ssh]").click();
    await expect.poll(async () => ((await app.calls("pty_spawn")).at(-1)?.args as any)?.req?.args).toEqual(["203.0.113.7"]);
  });

  test("stopping a machine asks first and only then calls the cloud", async ({ app, page }) => {
    const app1 = page.locator(".yc-body tbody tr").filter({ hasText: "app-1" });
    await app1.locator("[data-a=stop]").click();
    await expect(page.locator("dialog.ask")).toContainText("настоящая машина");
    await page.locator("dialog.ask button[value=cancel]").click();
    expect(await app.calls("yc_instance_op")).toHaveLength(0);

    await app1.locator("[data-a=stop]").click();
    await page.locator("dialog.ask button[value=ok]").click();
    expect((await app.called("yc_instance_op")).args).toEqual({ id: "fhm1", op: "stop" });
    // у остановленной машины вместо ⏹ кнопка запуска
    await expect(page.locator(".yc-body tbody tr").filter({ hasText: "db-1" }).locator("[data-a=start]")).toBeVisible();
  });

  test("networks, security groups, addresses, access and billing", async ({ app, page }) => {
    await page.locator('.yc-tabs [data-t="net"]').click();
    await expect(page.locator(".yc-group summary").first()).toContainText("подсетей 2");
    await expect(page.locator(".yc-body")).toContainText("10.128.0.0/24");

    await page.locator('.yc-tabs [data-t="sg"]').click();
    await expect(page.locator(".yc-group summary").first()).toContainText("правил 3");
    const rules = page.locator(".yc-body tbody tr");
    await expect(rules.first()).toContainText("входящее");
    await expect(rules.nth(1)).toContainText("эта же группа");
    await expect(rules.nth(2)).toContainText("исходящее");

    await page.locator('.yc-tabs [data-t="ip"]').click();
    // незанятый внешний адрес всё равно стоит денег — об этом сказано прямо
    await expect(page.locator(".yc-body tbody tr").nth(1)).toContainText("нет (платный простой)");
    // внутренние адреса тоже видны (у них своё поле в ответе CLI), и простой им не приписывается
    const internal = page.locator(".yc-body tbody tr").nth(2);
    await expect(internal).toContainText("10.128.0.21");
    await expect(internal).toContainText("внутренний");
    await expect(internal).not.toContainText("платный простой");

    await page.locator('.yc-tabs [data-t="iam"]').click();
    await expect(page.locator(".yc-body")).toContainText("ci-deploy");
    await expect(page.locator(".yc-body")).toContainText("editor");

    await page.locator('.yc-tabs [data-t="bill"]').click();
    await expect(page.locator(".yc-body tbody tr")).toContainText("12 430.55 RUB");
  });

  // в CLI 1.41 команды для платёжных аккаунтов нет: раздел объясняет это, а не показывает ошибку CLI
  test("a CLI without billing commands is explained, with a link to the console", async ({ app, page }) => {
    await app.override("yc_billing", { supported: false, accounts: [] });
    await page.locator('.yc-tabs [data-t="bill"]').click();
    await expect(page.locator(".yc-body")).toContainText("не умеет показывать платёжные аккаунты");
    await expect(page.locator(".yc-body")).not.toContainText("Unknown command");
    await page.locator("[data-a=billing-web]").click();
    expect((await app.called("open_external")).args).toEqual({ url: "https://console.yandex.cloud/billing" });
  });

  test("another folder is read on its own; the profile switch goes to the CLI", async ({ app, page }) => {
    await page.locator(".yc-folder").selectOption("b1gf2");
    await expect.poll(async () => ((await app.calls("yc_instances")).at(-1)!.args as any).folderId).toBe("b1gf2");
    await page.locator(".yc-profile").selectOption("work");
    expect((await app.called("yc_use_profile")).args).toEqual({ name: "work" });
  });

});

// раздел монтируется один раз, поэтому «нет CLI» ставим до запуска приложения
test.describe("Yandex Cloud without the CLI", () => {
  test.use({ demo: { overrides: { yc_status: { found: false, version: "", profile: "", profiles: [], cloud_id: "", folder_id: "", bin: "yc", error: "yc не найден — установите Yandex Cloud CLI и выполните «yc init» или укажите путь к файлу кнопкой ниже" } } } });

  test("the section explains what to install and asks the cloud for nothing", async ({ app, page }) => {
    await app.view("yc");
    await expect(page.locator(".yc-err")).toContainText("yc не найден");
    await expect(page.locator(".yc-body")).toContainText("не хранит ни токенов");
    expect(await app.calls("yc_clouds")).toHaveLength(0);
    expect(await app.calls("yc_instances")).toHaveLength(0);

    // CLI есть, но лежит не там, где её ищут (приложение из меню не читает ~/.bashrc): путь вручную
    await expect(page.locator(".yc-nobin")).toBeVisible();
    await page.locator("[data-a=yc-path]").click();
    await page.locator("dialog.ask input").fill("~/yandex-cloud/bin/yc");
    await page.locator("dialog.ask button[value=ok]").click();
    expect((await app.called("yc_set_path")).args).toEqual({ path: "~/yandex-cloud/bin/yc" });
  });
});
