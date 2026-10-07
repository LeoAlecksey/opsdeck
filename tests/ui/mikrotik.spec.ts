import { test, expect } from "./fixtures";

const PREVIEW = {
  file: "C:\\Users\\demo\\AppData\\Roaming\\MikroTik\\WinBox\\Addresses.cdb",
  items: [
    { name: "core-router", host: "192.0.2.1", port: 8291, username: "admin", group: "office", has_password: true, exists: true },
    { name: "Склад", host: "198.51.100.7", port: 8292, username: "noc", group: "warehouse", has_password: true, exists: false },
    { name: "E4:8D:8C:00:11:22", host: "E4:8D:8C:00:11:22", port: 8291, username: "", group: "", has_password: false, exists: false },
  ],
};

test.describe("MikroTik: import from WinBox", () => {
  test.use({ demo: { overrides: { mt_import_scan: PREVIEW, mt_import: 2 } } });

  test("shows the saved routers and adds the chosen ones", async ({ app, page }) => {
    await app.view("winbox");
    await page.click("[data-a=import]");
    const dlg = page.locator("dialog.mt-import");
    await expect(dlg).toBeVisible();
    expect((await app.called("mt_import_scan")).args).toEqual({ path: null });
    await expect(dlg.locator(".mt-import-file")).toHaveText(PREVIEW.file);
    const rows = dlg.locator("tbody tr");
    await expect(rows).toHaveCount(3);
    // already added: shown, but cannot be chosen
    await expect(rows.nth(0).locator("input")).toBeDisabled();
    await expect(rows.nth(0)).toContainText("уже есть");
    await expect(rows.nth(1)).toContainText(":8292");
    // passwords never reach the page
    expect(await dlg.innerHTML()).not.toMatch(/secret|password":/);
    await rows.nth(2).locator("input").uncheck();
    await dlg.locator("[data-a=import-go]").click();
    expect((await app.called("mt_import")).args).toEqual({ path: PREVIEW.file, chosen: ["198.51.100.7:8292"], passwords: true });
    await expect(dlg).toBeHidden();
    await expect(page.locator(".toast").last()).toContainText("Добавлено устройств: 2");
  });

  test("passwords can be left behind; nothing chosen — nothing to add", async ({ app, page }) => {
    await app.view("winbox");
    await page.click("[data-a=import]");
    const dlg = page.locator("dialog.mt-import");
    await expect(dlg.locator("tbody tr")).toHaveCount(3);
    await dlg.locator(".mt-import-all").uncheck();
    await expect(dlg.locator("[data-a=import-go]")).toBeDisabled();
    await dlg.locator(".mt-import-all").check();
    await dlg.locator("input[name=passwords]").uncheck();
    await dlg.locator("[data-a=import-go]").click();
    const args = (await app.called("mt_import")).args as any;
    expect(args.passwords).toBe(false);
    expect(args.chosen).toEqual(["198.51.100.7:8292", "E4:8D:8C:00:11:22:8291"]);
  });

  test("list not found: the reason and another file", async ({ app, page }) => {
    await page.evaluate(() => {
      const o = (window as any).__DEMO_OVERRIDES;
      o.mt_import_scan = (a: any) => { if (!a.path) throw "список адресов WinBox не найден — укажите файл Addresses.cdb"; return { file: a.path, items: [{ name: "r1", host: "203.0.113.5", port: 8291, username: "admin", group: "", has_password: false, exists: false }] }; };
      o.mt_import_pick = "/home/demo/Addresses.cdb";
    });
    await app.view("winbox");
    await page.click("[data-a=import]");
    const dlg = page.locator("dialog.mt-import");
    await expect(dlg.locator(".mt-import-err")).toContainText("не найден");
    await expect(dlg.locator("[data-a=import-go]")).toBeDisabled();
    await dlg.locator("[data-a=import-pick]").click();
    await expect(dlg.locator("tbody tr")).toHaveCount(1);
    await expect(dlg.locator(".mt-import-err")).toHaveText("");
    await expect(dlg.locator("[data-a=import-go]")).toBeEnabled();
  });
});
