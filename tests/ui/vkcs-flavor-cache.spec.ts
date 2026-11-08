import { test, expect } from "./fixtures";

test("configuration name stays visible while flavor metadata refreshes", async ({ app, page }) => {
  await app.view("vkcs");
  await expect(page.locator(".vkcs-body")).toContainText("4.0 GB");
  await app.override("vkcs_server_list", [{ id: "vm", name: "cached-vm", status: "RUNNING", zone: "", platform: "flavor-cache-id",
    flavor_id: "flavor-cache-id", cores: 0, memory: 0, core_fraction: 100, preemptible: false, internal_ip: "", public_ip: "", subnet_id: "" }]);
  await app.override("vkcs_instance_maps", { flavors: { "flavor-cache-id": { name: "Standard-2-4", cores: 2, memory: 4294967296 } }, floating: {} });
  await page.locator('.vkcs [data-a="refresh"]').click();
  await expect(page.locator(".vkcs-body")).toContainText("Standard-2-4");
  await page.evaluate(() => {
    const w = window as any;
    w.__DEMO_OVERRIDES.vkcs_instance_maps = () => new Promise((resolve) => { w.__finishFlavors = () => resolve({
      flavors: { "flavor-cache-id": { name: "Renamed-standard", cores: 2, memory: 4294967296 } }, floating: {},
    }); });
  });
  await page.locator('.vkcs [data-a="refresh"]').click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__finishFlavors)).toBe("function");
  await expect(page.locator(".vkcs-body")).toContainText("Standard-2-4");
  await expect(page.locator(".vkcs-body")).toContainText("4.0 GB");
  await expect(page.locator(".vkcs-body")).not.toContainText("flavor-cache-id");
  await page.evaluate(() => (window as any).__finishFlavors());
  await expect(page.locator(".vkcs-body")).toContainText("Renamed-standard");
});
