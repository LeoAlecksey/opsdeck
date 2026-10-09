import { test, expect } from "./fixtures";

test.describe("kubeconfig folders, like Freelens (#44)", () => {
  test("Settings: a folder is added, removed and saved", async ({ app, page }) => {
    await page.evaluate(() => { (window as any).__DEMO_OVERRIDES.pick_folder = "/home/demo/clusters"; });
    await app.view("settings");
    await expect(page.locator(".k8s-dirs")).toContainText("не добавлено");
    await page.click("[data-k8s-dir]");
    await expect(page.locator(".k8s-dir")).toHaveText(/\/home\/demo\/clusters/);
    await page.evaluate(() => { (window as any).__DEMO_OVERRIDES.pick_folder = "/srv/kube"; });
    await page.click("[data-k8s-dir]");
    await page.locator(".k8s-dir", { hasText: "/srv/kube" }).locator("[data-k8s-rm]").click();
    await expect(page.locator(".k8s-dir")).toHaveCount(1);
    await page.locator("section.view:not([hidden]) button[type=submit]", { hasText: "Сохранить" }).click();
    expect(((await app.called("settings_set")).args as any).settings.k8s_dirs).toEqual(["/home/demo/clusters"]);
  });

  test("clusters from a folder are listed with a «папка» badge", async ({ page, app }) => {
    await page.evaluate(() => {
      const o = (window as any).__DEMO_OVERRIDES;
      o.k8s_contexts = [
        { file: "/home/demo/.config/opsdeck/kube/prod-eu.yaml", source: "opsdeck", label: "prod-eu", context: "prod-eu", cluster: "prod-eu", user: "admin", namespace: "shop", current: true, server: "https://k8s.example.com:6443" },
        { file: "/home/demo/clusters/team-a.yaml", source: "dir", label: "team-a", context: "team-a-dev", cluster: "c", user: "u", namespace: "default", current: true, server: "https://dev.example.com" },
      ];
    });
    await app.view("k8s");
    const g = page.locator(".ctx-group", { has: page.locator(".ctx-file", { hasText: "team-a" }) });
    await expect(g.locator(".badge")).toHaveText("папка");
    await expect(g.locator(".ctx-name")).toContainText("team-a-dev");
  });
});
