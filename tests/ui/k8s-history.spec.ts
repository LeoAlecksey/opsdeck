import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

const rows = (page: Page) => page.locator(".k8s-main .table-wrap tbody tr:not(.skeleton-row)");
const ctxItem = (page: Page, name: string) => page.locator(".ctx-item", { has: page.locator(".ctx-name", { hasText: name }) });
const iso = (ago: number) => new Date(Date.now() - ago).toISOString();
const ev = (uid: string, type: string, reason: string, count: number, agoMin: number, ns = "shop", obj = "worker-1") => ({
  metadata: { uid, name: `${obj}.${uid}`, namespace: ns, creationTimestamp: iso(agoMin * 60000 + 3600000) },
  type, reason, message: `${reason}: details of ${obj}`, count, firstTimestamp: iso(agoMin * 60000 + 3600000), lastTimestamp: iso(agoMin * 60000),
  involvedObject: { kind: "Pod", name: obj, namespace: ns },
});

test.describe("Kubernetes event history (#55)", () => {
  test.beforeEach(async ({ app, page }) => {
    await page.evaluate(([a, b, c, d]) => {
      (window as any).__DEMO_OVERRIDES.k8s_history = (args: any) => ({ enabled: (window as any).__histOn ?? false, rows: args.warnings ? [a, b, c] : [a, b, c, d] });
      (window as any).__DEMO_OVERRIDES.k8s_history_set = (args: any) => { (window as any).__histOn = args.on; return null; };
    }, [ev("1", "Warning", "BackOff", 12, 5), ev("2", "Warning", "OOMKilling", 3, 30, "shop", "api-1"), ev("3", "Warning", "FailedScheduling", 1, 26 * 60, "kube-system", "coredns"), ev("4", "Normal", "Pulled", 2, 10)]);
    await app.view("k8s");
    await ctxItem(page, "prod-eu").click();
    await page.locator(".kind-list button", { hasText: "История событий" }).click();
  });

  test("events of the last week, with what fell over most in 24 h", async ({ app, page }) => {
    await expect(rows(page)).toHaveCount(3);
    expect(((await app.called("k8s_history")).args as any)).toMatchObject({ ctx: { context: "prod-eu" }, warnings: true });
    await expect(page.locator(".hist-state")).toContainText("Запись выключена");
    // 24 h summary: the 26-hour-old one is not in it
    await expect(page.locator(".hist-top .chip")).toHaveText(["BackOff ×12", "OOMKilling ×3"]);
    await page.locator(".hist-top .chip", { hasText: "OOMKilling" }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("api-1");
    // no watch for the history: it comes from OpsDeck's own store
    expect((await app.calls("k8s_watch_start")).map((c) => (c.args as any).kind)).not.toContain("event-history");
  });

  test("recording is turned on for this cluster", async ({ app, page }) => {
    await page.locator("[data-act=hist-toggle]").click();
    expect(((await app.called("k8s_history_set")).args as any)).toMatchObject({ ctx: { context: "prod-eu" }, on: true });
    await expect(page.locator(".hist-state")).toContainText("Запись идёт");
    await expect(page.locator("[data-act=hist-toggle]")).toHaveText("Остановить запись");
  });

  test("Normal events too; a row opens its message and ⇢ AI", async ({ app, page }) => {
    await page.locator(".hist-warn").uncheck();
    await expect(rows(page)).toHaveCount(4);
    await rows(page).filter({ hasText: "BackOff" }).click();
    await expect(page.locator(".hist-detail")).toContainText("BackOff: details of worker-1");
    await expect(page.locator(".hist-detail")).toContainText("×12");
    await page.locator(".drawer-actions button", { hasText: "AI" }).click();
    await expect.poll(async () => (await app.calls("pty_spawn")).length).toBeGreaterThan(0);
  });
});
