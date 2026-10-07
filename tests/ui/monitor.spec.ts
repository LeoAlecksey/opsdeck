import { test, expect } from "./fixtures";

const pickHosts = async (page: import("@playwright/test").Page, names: string[]) => {
  await page.click(".mon [data-a=pick]");
  const dlg = page.locator("dialog.mon-pick");
  await expect(dlg).toBeVisible();
  for (const n of names) await dlg.locator("label", { hasText: n }).locator("input").check();
  await dlg.locator("button[value=ok]").click();
};

test.describe("monitoring board", () => {
  test.beforeEach(async ({ app }) => { await app.view("monitor"); });

  test("empty at first; hosts from SSH profiles and ~/.ssh/config can be chosen", async ({ page }) => {
    await expect(page.locator(".mon-empty")).toContainText("＋ Хосты");
    await page.click(".mon [data-a=pick]");
    const items = page.locator("dialog.mon-pick .mon-pick-list label");
    await expect(items).toHaveCount(8);
    await expect(items.last()).toContainText("~/.ssh/config");
    await page.fill("dialog.mon-pick .mon-filter", "stage");
    await expect(items).toHaveCount(1);
  });

  test("cards show the metrics, coloured by the worst value", async ({ app, page }) => {
    await pickHosts(page, ["bastion", "db-primary", "monitoring"]);
    await expect.poll(async () => (await app.calls("mon_probe")).map((c) => (c.args as any).target).sort()).toEqual(["alias:monitoring", "id:h1", "id:h2"]);
    const cards = page.locator(".mon-card");
    await expect(cards).toHaveCount(3);
    const bastion = page.locator('.mon-card[data-k="id:h1"]');
    await expect(bastion).toContainText("CPU");
    await expect(bastion).toContainText("10%");
    await expect(bastion).toContainText("3.0 GB / 8.0 GB");
    await expect(bastion).toContainText("up 1д 1ч");
    await expect(bastion).toHaveClass(/\bok\b/);
    // disk at 95%
    await expect(page.locator('.mon-card[data-k="id:h2"]')).toHaveClass(/\bbad\b/);
    // groups become sections
    await expect(page.locator(".mon-group .side-head", { hasText: "prod" })).toBeVisible();
    // remembered
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem("opsdeck.mon.hosts")))!)).toEqual(["id:h1", "id:h2", "alias:monitoring"]);
  });

  test("a host without a key login says what to do", async ({ page }) => {
    await pickHosts(page, ["build-runner"]);
    const card = page.locator('.mon-card[data-k="id:h6"]');
    await expect(card).toHaveClass(/\bbad\b/);
    await expect(card.locator(".mon-err")).toContainText("ssh-copy-id");
  });

  test("cancel keeps the board as it was; refresh polls again", async ({ app, page }) => {
    await pickHosts(page, ["app-1"]);
    await expect(page.locator(".mon-card")).toHaveCount(1);
    await page.click(".mon [data-a=pick]");
    await page.locator("dialog.mon-pick label", { hasText: "app-2" }).locator("input").check();
    await page.locator("dialog.mon-pick button[value=cancel]").click();
    await expect(page.locator(".mon-card")).toHaveCount(1);
    const n = (await app.calls("mon_probe")).length;
    await page.click(".mon [data-a=refresh]");
    await expect.poll(async () => (await app.calls("mon_probe")).length).toBeGreaterThan(n);
  });

  test("the polling interval is remembered", async ({ page }) => {
    await page.selectOption(".mon-every", "60");
    expect(await page.evaluate(() => localStorage.getItem("opsdeck.mon.every"))).toBe("60");
  });
});

test.describe("monitoring board: fresh install", () => {
  test.use({ demo: { modules: null } });
  test("is off until turned on in ⊞", async ({ page }) => {
    await expect(page.locator('#sidebar button[data-view="monitor"]')).toBeHidden();
  });
});
