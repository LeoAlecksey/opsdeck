import { test, expect } from "./fixtures";

test("Machines → Networks → Machines shares the whole unfinished machine load", async ({ app, page }) => {
  await app.view("vkcs");
  await expect(page.locator(".vkcs-body")).toContainText("4.0 GB");
  await app.called("vkcs_access");
  const serversBefore = (await app.calls("vkcs_server_list")).length;
  const mapsBefore = (await app.calls("vkcs_instance_maps")).length;
  const networksBefore = (await app.calls("vkcs_networks")).length;
  await page.evaluate(() => {
    const w = window as any;
    w.__DEMO_OVERRIDES.vkcs_server_list = () => new Promise((resolve) => {
      w.__finishServers = () => resolve([{ id: "vm", name: "pending-vm", status: "RUNNING", zone: "", platform: "small",
        cores: 0, memory: 0, core_fraction: 100, preemptible: false, internal_ip: "", public_ip: "", subnet_id: "" }]);
    });
    w.__DEMO_OVERRIDES.vkcs_instance_maps = () => new Promise((resolve) => {
      w.__finishMaps = () => resolve({ flavors: { small: { name: "small", cores: 2, memory: 4294967296 } }, floating: {} });
    });
    w.__DEMO_OVERRIDES.vkcs_networks = () => new Promise((resolve) => { w.__finishNetworks = () => resolve([]); });
  });
  await page.locator('.vkcs [data-a="refresh"]').click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__finishServers)).toBe("function");
  await page.locator('.vkcs-tabs [data-t="net"]').click();
  await app.called("vkcs_networks");
  await page.locator('.vkcs-tabs [data-t="vm"]').click();
  expect(await app.calls("vkcs_server_list")).toHaveLength(serversBefore + 1);
  await page.evaluate(() => (window as any).__finishServers());
  await expect.poll(() => page.evaluate(() => typeof (window as any).__finishMaps)).toBe("function");
  await expect(page.locator(".vkcs-body")).toContainText("pending-vm");
  await page.locator('.vkcs-tabs [data-t="net"]').click();
  await page.locator('.vkcs-tabs [data-t="vm"]').click();
  await expect(page.locator(".vkcs-body")).toContainText("pending-vm");
  expect(await app.calls("vkcs_server_list")).toHaveLength(serversBefore + 1);
  expect(await app.calls("vkcs_instance_maps")).toHaveLength(mapsBefore + 1);
  expect(await app.calls("vkcs_networks")).toHaveLength(networksBefore + 1);
  await page.evaluate(() => (window as any).__finishMaps());
  await expect(page.locator(".vkcs-body")).toContainText("4.0 GB");
  await page.evaluate(() => (window as any).__finishNetworks());
  await expect(page.locator(".vkcs-body")).toContainText("pending-vm");
});

test("denied role listing is explained and retried only explicitly", async ({ app, page }) => {
  await app.override("vkcs_access", { denied: true, rows: [] });
  await app.view("vkcs");
  await expect(page.locator(".vkcs-body")).toContainText("app-1");
  await page.locator('.vkcs-tabs [data-t="iam"]').click();
  await expect(page.locator(".vkcs-body")).toContainText("Нет разрешения на просмотр назначенных ролей");
  await expect(page.locator(".vkcs-body .err")).toHaveCount(0);
  const count = (await app.calls("vkcs_access")).length;
  await page.locator('.vkcs-tabs [data-t="vm"]').click();
  await page.locator('.vkcs-tabs [data-t="iam"]').click();
  await expect(page.locator(".vkcs-body")).toContainText("Нет разрешения на просмотр назначенных ролей");
  expect(await app.calls("vkcs_access")).toHaveLength(count);
  await app.override("vkcs_access", { denied: false, rows: [{ role: "member", kind: "user", subject: "test-user" }] });
  await page.locator('[data-a="access-retry"]').click();
  await expect(page.locator(".vkcs-body")).toContainText("test-user");
  expect(await app.calls("vkcs_access")).toHaveLength(count + 1);
});
