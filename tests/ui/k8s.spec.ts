import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

const rows = (page: Page) => page.locator(".k8s-main .table-wrap tbody tr:not(.skeleton-row)");
const ctxItem = (page: Page, name: string) => page.locator(".ctx-item", { has: page.locator(".ctx-name", { hasText: name }) });

test.describe("kubernetes", () => {
  test.beforeEach(async ({ app, page }) => {
    await app.view("k8s");
    await ctxItem(page, "prod-eu").click();
  });

  // несколько namespace под рукой: плашки, между которыми переключаются кликом (#79)
  test("namespaces become chips you switch between, and a chip can be removed", async ({ app, page }) => {
    const chips = page.locator(".ns-tabs .ns-tab");
    await page.locator(".ns-select").selectOption("shop");
    await expect.poll(async () => ((await app.calls("k8s_watch_start")).at(-1)!.args as any).namespace).toBe("shop");
    await page.locator(".ns-select").selectOption("monitoring");
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(1)).toHaveClass(/active/);

    // клик по плашке возвращает прежний namespace, не открывая список
    await chips.nth(0).click();
    await expect.poll(async () => ((await app.calls("k8s_watch_start")).at(-1)!.args as any).namespace).toBe("shop");
    await expect(page.locator(".ns-select")).toHaveValue("shop");
    await expect(chips.nth(0)).toHaveClass(/active/);

    // × убирает плашку, выбранный namespace остаётся
    await chips.nth(1).locator(".x").click();
    await expect(chips).toHaveCount(1);
    await expect(page.locator(".ns-select")).toHaveValue("shop");
  });

  // без мыши: стрелки, Пробел и Enter по таблице, Alt+↑/↓ по разделам (#79)
  test("the table is driven from the keyboard, Alt+arrows walk the kinds", async ({ app, page }) => {
    await expect(rows(page)).toHaveCount(10);
    await page.locator(".k8s-main .table-wrap").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("ArrowDown");
    await expect(rows(page).nth(0)).toHaveClass(/cur/);
    await page.keyboard.press("ArrowDown");
    await expect(rows(page).nth(1)).toHaveClass(/cur/);
    await page.keyboard.press("ArrowUp");
    await expect(rows(page).nth(0)).toHaveClass(/cur/);

    // Enter открывает подробности той же строки
    await page.keyboard.press("Enter");
    await expect(page.locator(".drawer .obj-title")).toContainText("worker-5c8d7f9b6-t9qjd");
    await expect(rows(page).nth(0)).toHaveClass(/sel/);

    // Alt+↓ — следующий раздел слева
    const active = () => page.locator(".kind-item.active").innerText();
    expect(await active()).toBe("Pods");
    await page.keyboard.press("Alt+ArrowDown");
    await expect.poll(active).not.toBe("Pods");
    await page.keyboard.press("Alt+ArrowUp");
    await expect.poll(active).toBe("Pods");
  });

  test("a context shows live pods with CPU/RAM", async ({ app, page }) => {
    const watch = await app.called("k8s_watch_start");
    expect(watch.args).toMatchObject({ kind: "pods", ctx: { context: "prod-eu" } });
    await expect(rows(page)).toHaveCount(10);
    await expect(page.locator(".k8s-main thead")).toContainText("CPU");
    await expect(rows(page).filter({ hasText: "worker-5c8d7f9b6-t9qjd" })).toContainText("120m");
    await expect(rows(page).filter({ hasText: "worker-5c8d7f9b6-lp2vx" })).toContainText("CrashLoopBackOff");
    await page.locator(".k8s-bar .filter").fill("worker");
    await expect(rows(page)).toHaveCount(2);
  });

  test("label filter like kubectl -l (from feedback)", async ({ page }) => {
    await expect(rows(page)).toHaveCount(10);
    const lf = page.locator(".k8s-bar .lfilter");
    await lf.fill("app=worker");
    await expect(rows(page)).toHaveCount(2);
    await lf.fill("app in (worker, api)");
    const n = await rows(page).count();
    expect(n).toBeGreaterThanOrEqual(2);
    await lf.fill("app!=worker");
    await expect(rows(page)).toHaveCount(8);
    await lf.fill("app=worker, =broken");
    await expect(lf).toHaveClass(/\bbad\b/);
    await expect(rows(page), "a broken selector does not filter").toHaveCount(10);
    await lf.fill("");
    await expect(lf).not.toHaveClass(/\bbad\b/);
  });

  // из отчёта: клик по RAM расставлял узлы по гигабайтам, хотя колонка красится по доле занятого,
  // и стрелка в шапке показывала противоположное направление
  test("nodes sort by the share of capacity, and the arrow matches the order", async ({ page }) => {
    const node = (name: string, mem: string) => ({ metadata: { name, uid: name, creationTimestamp: new Date().toISOString() },
      status: { allocatable: { cpu: "4", memory: mem }, conditions: [{ type: "Ready", status: "True" }], nodeInfo: { kubeletVersion: "v1.31.2" } } });
    await page.evaluate(([big, small]) => {
      const o = (window as any).__DEMO_OVERRIDES;
      o.k8s_list = (a: any) => (a.kind === "nodes" ? [big, small] : undefined);
      // big: 24 ГБ из 64 (37%), small: 7 ГБ из 8 (87%) — по байтам и по доле порядок разный
      o.k8s_metrics = (a: any) => (a.kind === "nodes"
        ? [{ namespace: "", name: "big", cpu_m: 100, mem: 24 * 2 ** 30 }, { namespace: "", name: "small", cpu_m: 100, mem: 7 * 2 ** 30 }]
        : []);
      o.k8s_watch_start = (a: any) => { setTimeout(() => (window as any).__demoEmit(`k8s-watch-${a.id}`, { type: "reset", items: a.kind === "nodes" ? [big, small] : [] }), 30); return null; };
    }, [node("big", "64Gi"), node("small", "8Gi")]);
    await page.locator(".kind-list button", { hasText: "Nodes" }).click();
    await expect(rows(page)).toHaveCount(2);

    const names = () => rows(page).locator("td:first-child").allTextContents();
    const ramTh = page.locator(".k8s-main thead th", { hasText: "RAM" });
    await ramTh.click();
    // первый клик — самые загруженные сверху, и стрелка это подтверждает
    await expect.poll(names).toEqual(["small", "big"]);
    await expect(ramTh).toHaveClass(/desc/);
    await ramTh.click();
    await expect.poll(names).toEqual(["big", "small"]);
    await expect(ramTh).toHaveClass(/asc/);
  });

  test("nodes: live CPU/RAM with a bar and a sparkline (from feedback)", async ({ app, page }) => {
    const node = (name: string) => ({ metadata: { name, uid: name, labels: { "node-role.kubernetes.io/worker": "" }, creationTimestamp: new Date().toISOString() },
      status: { allocatable: { cpu: "4", memory: "16Gi" }, conditions: [{ type: "Ready", status: "True" }], nodeInfo: { kubeletVersion: "v1.31.2" } } });
    let cpu = 1000;
    await page.exposeFunction("__nextCpu", () => (cpu += 400));
    await page.evaluate(([n1, n2]) => {
      const o = (window as any).__DEMO_OVERRIDES;
      const list = o.k8s_list;
      o.k8s_list = (a: any) => (a.kind === "nodes" ? [n1, n2] : list ? list(a) : undefined);
      o.k8s_metrics = async (a: any) => a.kind === "nodes"
        ? [{ namespace: "", name: "node-a", cpu_m: await (window as any).__nextCpu(), mem: 4 * 2 ** 30 }, { namespace: "", name: "node-b", cpu_m: 3600, mem: 15 * 2 ** 30 }]
        : [];
      o.k8s_watch_start = (a: any) => { setTimeout(() => (window as any).__demoEmit(`k8s-watch-${a.id}`, { type: "reset", items: a.kind === "nodes" ? [n1, n2] : [] }), 30); return null; };
    }, [node("node-a"), node("node-b")]);
    await page.locator(".kind-list button", { hasText: "Nodes" }).click();
    const a = rows(page).filter({ hasText: "node-a" });
    await expect(a.locator(".k8s-live").first()).toBeVisible();
    await expect(a).toContainText("25%");
    // a hot node is marked
    await expect(rows(page).filter({ hasText: "node-b" }).locator("td.bad").first()).toBeVisible();
    // refreshed every 5 s: the sparkline appears after a second sample
    await expect(a.locator(".k8s-spark polyline").first()).toBeVisible({ timeout: 12000 });
  });

  test("watch events update the table", async ({ app, page }) => {
    const id = (await app.called("k8s_watch_start")).args.id as string;
    await expect(rows(page)).toHaveCount(10);
    const gone = await page.evaluate(() => "u1"); // uid of the first demo pod
    await app.emit(`k8s-watch-${id}`, { type: "delete", uids: [gone] });
    await expect(rows(page)).toHaveCount(9);
    await app.emit(`k8s-watch-${id}`, { type: "error", message: "forbidden: pods is forbidden" });
    await expect(page.locator(".k8s-err")).toContainText("forbidden");
  });

  test("read-only context: no shell or delete, and the badge is shown", async ({ page }) => {
    await expect(page.locator(".ro-badge")).toBeVisible();
    await rows(page).first().click();
    await expect(page.locator(".drawer")).toBeVisible();
    await expect(page.locator(".drawer-tabs")).toContainText("Логи");
    await expect(page.locator(".drawer-tabs")).toContainText("YAML");
    await expect(page.locator(".drawer-actions")).not.toContainText("Shell");
    await expect(page.locator(".drawer-actions")).not.toContainText("Удалить");
  });

  test("toggle read-only for a context", async ({ app, page }) => {
    await ctxItem(page, "stage").hover();
    await ctxItem(page, "stage").locator("[data-p=ro]").click();
    const set = await app.called("k8s_prefs_set");
    expect((set.args as any).prefs.readonly).toContain("/home/demo/.config/opsdeck/kube/stage.yaml|stage");
  });

  test("delete asks for the object name", async ({ app, page }) => {
    await ctxItem(page, "stage").click();
    await expect(rows(page)).toHaveCount(10);
    await rows(page).filter({ hasText: "redis-0" }).click();
    await page.locator(".drawer-actions button", { hasText: "Удалить" }).click();
    const dlg = page.locator("dialog.ask");
    await dlg.locator("input").fill("wrong-name");
    await dlg.locator("button[value=ok]").click();
    await expect(page.locator(".toast")).toContainText("Имя не совпало");
    expect(await app.calls("k8s_delete")).toHaveLength(0);
    await page.locator(".drawer-actions button", { hasText: "Удалить" }).click();
    await dlg.locator("input").fill("redis-0");
    await dlg.locator("button[value=ok]").click();
    const del = await app.called("k8s_delete");
    expect(del.args).toMatchObject({ kind: "pods", name: "redis-0", namespace: "shop", force: false, ctx: { context: "stage" } });
  });

  test("resource kinds and the shell button", async ({ app, page }) => {
    await page.locator(".kind-list button", { hasText: "Deployments" }).click();
    await expect.poll(async () => (await app.calls("k8s_watch_start")).map((c) => c.args.kind)).toContain("deployments");
    // ⎈ Terminal (kubectl for this context) is off in a read-only context
    await expect(page.locator("[data-act=shell]")).toBeDisabled();
    await ctxItem(page, "stage").click();
    await page.locator("[data-act=shell]").click();
    await app.called("k8s_shell_config");
  });
});
