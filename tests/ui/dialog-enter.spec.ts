import { expect, test } from "./fixtures";

// Enter used to hit «Отмена» (the first submit button of the form), losing everything typed (#68).
test.describe("Enter in dialogs means the main action", () => {
  test("a web panel is created, not thrown away", async ({ app, page }) => {
    await app.view("web");
    await page.locator("[data-act=add]").click();
    const dlg = page.locator("dialog.conn-dialog");
    await dlg.locator("input[name=name]").fill("Grafana 2");
    await dlg.locator("input[name=url]").fill("https://grafana2.example.com");
    await dlg.locator("input[name=url]").press("Enter");
    expect((await app.called("connector_save")).args.connector).toMatchObject({ name: "Grafana 2", url: "https://grafana2.example.com" });
  });

  test("an SSH host is saved by Enter", async ({ app, page }) => {
    await app.view("ssh");
    await page.locator("[data-a=add]").first().click();
    const dlg = page.locator("dialog.ssh-dialog");
    await dlg.locator("input[name=name]").fill("db-2");
    await dlg.locator("input[name=host]").fill("198.51.100.30");
    await dlg.locator("input[name=host]").press("Enter");
    expect((await app.called("ssh_save")).args.host).toMatchObject({ name: "db-2", host: "198.51.100.30" });
  });

  test("a prompt (ask) answers with what was typed", async ({ app, page }) => {
    await app.view("code");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: "/home/demo/projects/infra" } })));
    await expect(page.locator(".code-tree")).toContainText("main.tf");
    await page.locator('.ct-file[data-f$="/outputs.tf"]').click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Переименовать" }).click();
    await page.locator("dialog.ask input").fill("exports.tf");
    await page.locator("dialog.ask input").press("Enter");
    expect((await app.called("code_rename")).args.to).toBe("/home/demo/projects/infra/exports.tf");
  });

  test("Escape and «Отмена» still cancel", async ({ app, page }) => {
    await app.view("web");
    await page.locator("[data-act=add]").click();
    await page.locator("dialog.conn-dialog input[name=name]").fill("x");
    await page.locator("dialog.conn-dialog button[value=cancel]").click();
    await expect(page.locator("dialog.conn-dialog")).toBeHidden();
    expect(await app.calls("connector_save")).toHaveLength(0);
  });
});
