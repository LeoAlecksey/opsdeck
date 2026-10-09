import { expect, test } from "./fixtures";

test.describe("databases via a jump host (#61)", () => {
  test("the dialog offers SSH hosts and saves the choice", async ({ app, page }) => {
    await app.view("db");
    await page.getByTitle("Новое подключение").click();
    const jump = page.locator("dialog.db-dialog select[name=jump]");
    await expect(jump.locator("option").first()).toHaveText("напрямую");
    expect(await jump.locator("option").count()).toBeGreaterThan(2);
    const first = await jump.locator("option").nth(1).getAttribute("value");
    expect(first).toMatch(/^(id|alias):/);
    await page.locator("dialog.db-dialog input[name=name]").fill("orders-via-bastion");
    await page.locator("dialog.db-dialog input[name=host]").fill("10.1.0.5");
    await jump.selectOption(first!);
    await page.locator("dialog.db-dialog button[value=save]").click();
    expect((await app.called("db_save")).args.profile).toMatchObject({ host: "10.1.0.5", jump: first });
  });
});
