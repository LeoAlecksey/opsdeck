import { test, expect } from "./fixtures";

test.describe("moving OpsDeck to another computer (from feedback)", () => {
  test.beforeEach(async ({ app }) => { await app.view("settings"); });

  test("export: choose parts; kubeconfig is off by default and warned about", async ({ app, page }) => {
    await page.click("[data-x=export]");
    const dlg = page.locator(".xfer-dlg");
    await expect(dlg.locator(".xfer-part")).toHaveCount(5);
    await expect(dlg.locator("input[value=kubeconfigs]")).not.toBeChecked();
    await expect(dlg.locator(".xfer-part", { hasText: "kubeconfig" })).toContainText("токены");
    await expect(dlg.locator("input[value=databases]"), "nothing to export").toBeDisabled();
    await expect(dlg.locator(".xfer-part", { hasText: "Заметки" })).toContainText("1840");
    await dlg.locator("input[value=ssh]").uncheck();
    await page.evaluate(() => localStorage.setItem("opsdeck.term.theme", "Campbell"));
    await dlg.locator(".xfer-go").click();
    const call = (await app.called("transfer_export")).args as any;
    expect(call.parts).toEqual(["settings", "notes"]);
    expect(JSON.parse(call.ui)["opsdeck.term.theme"]).toBe("Campbell");
    await expect(dlg).toBeHidden();
    await expect(page.locator(".toast").last()).toContainText("opsdeck-2026-10-08.zip");
  });

  test("import: what is in the archive, where the notes go, restart", async ({ app, page }) => {
    await page.click("[data-x=import]");
    const dlg = page.locator(".xfer-dlg");
    await expect(dlg.locator(".xfer-from")).toContainText("OpsDeck 0.6.0");
    await expect(dlg.locator(".xfer-part")).toHaveCount(2);
    const dest = dlg.locator("input[name=notes_dest]");
    await expect(dest).toHaveValue("/home/demo/notes");
    await dest.fill("/home/demo/work-notes");
    await dlg.locator(".xfer-go").click();
    expect((await app.called("transfer_import")).args).toMatchObject({ path: "/home/demo/Downloads/opsdeck-2026-10-08.zip", parts: ["settings", "notes"], notesDest: "/home/demo/work-notes" });
    const done = page.locator("dialog.ask");
    await expect(done).toContainText("1845");
    await expect(done).toContainText("backup-20261008");
    expect(await page.evaluate(() => localStorage.getItem("opsdeck.term.theme")), "interface settings applied").toBe("Dracula");
    await done.locator("button[value=ok]").click();
    await app.called("app_restart");
  });

  test("import without notes: no folder to choose", async ({ page }) => {
    await page.click("[data-x=import]");
    const dlg = page.locator(".xfer-dlg");
    await expect(dlg.locator(".xfer-notes")).toBeVisible();
    await dlg.locator("input[value=notes]").uncheck();
    await expect(dlg.locator(".xfer-notes")).toBeHidden();
  });
});
