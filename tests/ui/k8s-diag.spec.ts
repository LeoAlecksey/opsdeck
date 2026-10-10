import { test, expect } from "./fixtures";

test.describe("kubernetes diagnostics", () => {
  test.beforeEach(async ({ app, page }) => {
    await app.view("k8s");
    await page.locator(".ctx-item", { has: page.locator(".ctx-name", { hasText: "prod-eu" }) }).click();
  });

  test("the resource list still opens on Pods", async ({ page }) => {
    await expect(page.locator(".kind-list .kind-item.active")).toHaveText("Pods");
  });

  test("Проблемы: crashing pods, rollout, a service without pods, an ingress to nowhere", async ({ page }) => {
    await page.locator(".kind-list button", { hasText: "Проблемы" }).click();
    const rows = page.locator(".k8s-main .table-wrap tbody tr");
    await expect(rows.first()).toContainText("критично");
    const text = await rows.allTextContents();
    expect(text.join("\n")).toContain("CrashLoopBackOff: app");
    expect(text.join("\n")).toContain("Селектор не находит ни одного пода");
    expect(text.join("\n")).toContain("Сервиса «catalog» нет");
    expect(text.join("\n")).toContain("Доступно 1/2");
    await expect(page.locator(".diag-sum")).toContainText("критично");
    // a row opens what is wrong and how to get to the object
    await rows.filter({ hasText: "Селектор" }).click();
    await expect(page.locator(".drawer-body")).toContainText("app=legacy-api");
    await page.locator(".drawer-actions button", { hasText: "Открыть объект" }).click();
    await expect(page.locator(".kind-list .kind-item.active")).toHaveText("Services");
  });

  test("Проверки: a privileged container and a latest tag, with a fix", async ({ page }) => {
    await page.locator(".kind-list button", { hasText: "Проверки" }).click();
    const rows = page.locator(".k8s-main .table-wrap tbody tr");
    await expect(rows.first()).toContainText("критично");
    await expect(rows.filter({ hasText: "privileged: app" })).toHaveCount(1);
    await rows.filter({ hasText: "Образ без версии" }).first().click();
    await expect(page.locator(".drawer-body")).toContainText("Как исправить");
  });
});
