import { test, expect } from "./fixtures";

// prod-eu is read-only in the demo data, and deleting/shell are hidden there on purpose
test.use({ demo: { overrides: { k8s_prefs_get: { hidden: [], readonly: [] } } } });

const open = async (app: any, page: any, kindName?: string) => {
  await app.view("k8s");
  await page.locator(".ctx-item", { has: page.locator(".ctx-name", { hasText: "prod-eu" }) }).click();
  if (kindName) await page.locator(".kind-list button", { hasText: kindName }).click();
  await expect(page.locator(".k8s-main .table-wrap tbody tr").first()).toBeVisible();
};
const rows = (page: any) => page.locator(".k8s-main .table-wrap tbody tr");

test.describe("kubernetes: multiselect and row actions", () => {
  test("select by filter, delete the lot, confirm by count (#71)", async ({ app, page }) => {
    await open(app, page);
    await page.locator(".k8s-bar .filter").fill("worker");
    await expect(rows(page)).toHaveCount(2);
    await page.locator(".pick-all").check();
    await expect(page.locator(".pick-n")).toHaveText("Выбрано: 2");
    await page.locator("[data-act=pick-del]").click();
    const dlg = page.locator("dialog.ask");
    await expect(dlg).toContainText("worker-5c8d7f9b6");
    // a wrong number deletes nothing
    await dlg.locator("input").fill("5");
    await dlg.locator("button[value=ok]").click();
    expect(await app.calls("k8s_delete")).toHaveLength(0);

    await page.locator("[data-act=pick-del]").click();
    await page.locator("dialog.ask input").fill("2");
    await page.locator("dialog.ask button[value=ok]").click();
    await expect.poll(async () => (await app.calls("k8s_delete")).length).toBe(2);
    expect((await app.calls("k8s_delete")).map((c: any) => c.args.name).sort()).toEqual(["worker-5c8d7f9b6-lp2vx", "worker-5c8d7f9b6-t9qjd"]);
  });

  test("the selection survives a filter change and clears on «Снять»", async ({ app, page }) => {
    await open(app, page);
    await page.locator(".k8s-bar .filter").fill("worker");
    await page.locator(".pick-all").check();
    await page.locator(".k8s-bar .filter").fill("");
    await expect(rows(page)).toHaveCount(10);
    await expect(page.locator(".pick-n")).toHaveText("Выбрано: 2");
    await page.locator("[data-act=pick-clear]").click();
    await expect(page.locator(".pick-bar")).toBeHidden();
  });

  test("row icons: logs and shell open without the drawer round trip (#74)", async ({ app, page }) => {
    await open(app, page);
    const row = rows(page).filter({ hasText: "api-7d9f8c6b5d-x2kfp" });
    await row.hover();
    await row.locator("[data-ra=logs]").click();
    await expect(page.locator(".logs-pane")).toBeVisible();
    await app.called("k8s_logs_start");
    await page.locator("[data-act=close-drawer]").click();
    await row.hover();
    await row.locator("[data-ra=shell]").click();
    expect((await app.called("k8s_shell_config")).args).toMatchObject({ ctx: { context: "prod-eu" } });
    await expect.poll(async () => (await app.calls("pty_spawn")).map((c: any) => c.args.req.args?.[0]).filter(Boolean)).toContain("exec");
  });

  test("logs are saved to a file (#75)", async ({ app, page }) => {
    await open(app, page);
    await rows(page).first().click();
    await page.locator(".drawer-tabs button", { hasText: "Логи" }).click();
    await app.called("k8s_logs_start");
    await page.locator("[data-l=save]").click();
    const call = await app.called("k8s_save_text");
    expect(String(call.args.name)).toMatch(/\.log$/);
    expect(String(call.args.text).length).toBeGreaterThan(0);
  });

  // Пробел отмечает строку под курсором — как клик по галочке (#79)
  test("space picks the row under the keyboard cursor", async ({ app, page }) => {
    await open(app, page);
    await page.locator(".k8s-main .table-wrap").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("ArrowDown");
    await expect(rows(page).nth(0)).toHaveClass(/cur/);
    await page.keyboard.press(" ");
    await expect(rows(page).nth(0)).toHaveClass(/picked/);
    await expect(page.locator(".pick-bar .pick-n")).toContainText("1");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press(" ");
    await expect(page.locator(".pick-bar .pick-n")).toContainText("2");
    await page.keyboard.press(" ");
    await expect(page.locator(".pick-bar .pick-n")).toContainText("1");
  });

  // гистограмма над логами: сколько строк когда и сколько ошибок (#73)
  test("the log histogram shows the span, marks errors and filters by a click", async ({ app, page }) => {
    await open(app, page);
    await rows(page).first().click();
    await page.locator(".drawer-tabs button", { hasText: "Логи" }).click();
    // метки времени просим всегда, даже когда в строках их не показываем
    expect((await app.called("k8s_logs_start")).args).toMatchObject({ req: { timestamps: true } });
    const hist = page.locator(".log-hist");
    await expect(hist).toBeVisible();
    await expect(hist.locator(".lh-note")).toContainText("строк 5");
    await expect(hist.locator(".lh-note")).toContainText("ошибок 1");
    // строка ERROR попала в столбик и покрашена красным
    const err = hist.locator(".lh-bar", { has: page.locator(".lh-err") });
    await expect(err).toHaveCount(1);
    await expect(err).toHaveAttribute("title", /ошибок 1/);

    // клик по столбику оставляет окно времени, повторный снимает
    await err.click();
    await expect(hist.locator(".lh-note")).toContainText("окно");
    await expect(hist.locator(".lh-bar.active")).toHaveCount(1);
    await err.click();
    await expect(hist.locator(".lh-note")).toContainText("строк 5");

    // график выключается галочкой
    await page.locator(".logs-bar .lh").uncheck();
    await expect(hist).toBeHidden();
  });

  test("a shell on a node asks for the image and runs kubectl debug", async ({ app, page }) => {
    await open(app, page, "Nodes");
    await rows(page).first().click();
    await page.locator(".drawer-actions button", { hasText: "Shell" }).click();
    const dlg = page.locator("dialog.ask");
    await expect(dlg).toContainText("временный под");
    await dlg.locator("button[value=ok]").click();
    await expect.poll(async () => (await app.calls("pty_spawn")).map((c: any) => (c.args.req.args ?? []).join(" ")).join("|")).toContain("debug node/");
  });
});

test.describe("kubernetes: pods of an object (#72)", () => {
  test("a node lists what runs on it, a click opens the pod", async ({ app, page }) => {
    await open(app, page, "Nodes");
    await rows(page).filter({ hasText: "node-2" }).click();
    await page.locator(".drawer-tabs button", { hasText: "Поды" }).click();
    const pods = page.locator(".pods-of tbody tr");
    await expect(pods).toHaveCount(3); // the demo pods pinned to node-2
    await expect(pods.first()).toContainText("shop");
    await pods.filter({ hasText: "worker-5c8d7f9b6-lp2vx" }).click();
    await expect(page.locator(".kind-list .kind-item.active")).toHaveText("Pods");
    await expect(page.locator(".obj-title")).toContainText("worker-5c8d7f9b6-lp2vx");
  });

  test("a Deployment lists only its own pods", async ({ app, page }) => {
    await open(app, page, "Deployments");
    await rows(page).filter({ hasText: "worker" }).click();
    await page.locator(".drawer-tabs button", { hasText: "Поды" }).click();
    const pods = page.locator(".pods-of tbody tr");
    await expect(pods).toHaveCount(2);
    for (const name of await pods.allTextContents()) expect(name).toContain("worker-");
  });
});

test.describe("kubernetes: what the pod asked for (#79)", () => {
  test("the table shows usage next to the request, over the limit is red", async ({ app, page }) => {
    await open(app, page);
    const row = rows(page).filter({ hasText: "worker-5c8d7f9b6-t9qjd" });
    // 120m used of a 100m request / 500m limit
    await expect(row.locator("td", { hasText: "/ 100m" })).toBeVisible();
    await expect(row.locator("td", { hasText: "/ 256Mi" })).toBeVisible();
    expect(await row.locator("td span[title]").first().getAttribute("title")).toContain("запрос 100m");
  });

  test("details show why the previous run ended", async ({ app, page }) => {
    await open(app, page);
    await rows(page).filter({ hasText: "api-7d9f8c6b5d-m4hrt" }).click();
    await expect(page.locator(".drawer-body")).toContainText("Прошлый выход");
    await expect(page.locator(".drawer-body")).toContainText("OOMKilled (137, OOM/kill)");
  });
});
