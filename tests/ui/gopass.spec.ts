import { expect, test } from "./fixtures";

test.describe("gopass", () => {
  test.use({ demo: { modules: ["terminal", "ssh", "gopass"] } });

  test("the section lists entry paths and copies a password", async ({ app, page }) => {
    await app.view("gopass");
    const row = page.locator(".kp-table tr", { hasText: "db-main" });
    await expect(row).toContainText("infra/prod");
    await row.locator("[data-c=password]").click();
    expect((await app.called("gp_copy")).args).toEqual({ id: "infra/prod/db-main", field: "password" });
  });

  test("an SSH host takes its password from a gopass entry", async ({ app, page }) => {
    await app.view("ssh");
    await page.locator("[data-a=add]").first().click();
    const dlg = page.locator("dialog.ssh-dialog");
    await dlg.locator("input[name=name]").fill("db-main");
    await dlg.locator("input[name=host]").fill("198.51.100.30");
    await dlg.locator("select[name=auth]").selectOption("gopass");
    await dlg.locator("[data-s=gopass] [data-a=gp-pick]").click();
    await page.locator("dialog.kp-picker .kp-pitem", { hasText: "db-main" }).click();
    await expect(dlg.locator(".gp-bound")).toHaveText("infra/prod/db-main");
    await dlg.locator("input[name=host]").press("Enter");
    expect((await app.called("ssh_save")).args.host).toMatchObject({ auth: "gopass", gopass_entry: "infra/prod/db-main" });
  });
});

test.describe("gopass not installed", () => {
  test.use({ demo: { modules: ["terminal", "gopass"], overrides: { gp_status: { installed: false, version: "", ready: false, error: "gopass не найден: установите его (gopass.pw) и откройте OpsDeck заново" } } } });

  test("the section says what to install and lists nothing", async ({ app, page }) => {
    await app.view("gopass");
    await expect(page.locator(".gp-missing")).toContainText("gopass.pw");
    expect(await app.calls("gp_entries")).toHaveLength(0);
  });
});
