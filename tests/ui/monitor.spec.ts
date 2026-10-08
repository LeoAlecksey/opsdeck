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

  test("a host can be taken off the board (from feedback)", async ({ page }) => {
    await pickHosts(page, ["bastion", "app-1"]);
    await expect(page.locator(".mon-card")).toHaveCount(2);
    await page.locator('.mon-card[data-k="id:h1"]').hover();
    await page.locator('.mon-card[data-k="id:h1"] [data-rm]').click();
    await expect(page.locator(".mon-card")).toHaveCount(1);
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem("opsdeck.mon.hosts")))!)).toEqual(["id:h3"]);
  });

  test("a whole group can be taken off, after a confirmation (from feedback)", async ({ page }) => {
    await pickHosts(page, ["bastion", "app-1", "stage-1"]);
    await expect(page.locator(".mon-card")).toHaveCount(3);
    const prod = page.locator('.mon-group[data-g="prod"]');
    await prod.locator(".mon-ghead").hover();
    await prod.locator("[data-rmg]").click();
    const dlg = page.locator("dialog.ask");
    await expect(dlg).toContainText("prod");
    await dlg.locator("button", { hasText: "Убрать" }).click();
    await expect(page.locator(".mon-card")).toHaveCount(1);
    await expect(page.locator('.mon-card[data-k="id:h5"]')).toBeVisible();
  });

  test("groups fold: a summary instead of cards, and they are not polled (from feedback)", async ({ app, page }) => {
    await pickHosts(page, ["bastion", "db-primary", "stage-1"]);
    await expect(page.locator('.mon-card[data-k="id:h2"]')).toHaveClass(/\bbad\b/);
    const prod = page.locator('.mon-group[data-g="prod"]');
    await prod.locator("[data-fold]").click();
    await expect(prod.locator(".mon-card")).toHaveCount(0);
    // last known state: one red (disk 95%), one green
    await expect(prod.locator(".mon-tally")).toHaveCount(2);
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem("opsdeck.mon.folded")))!)).toEqual(["prod"]);
    const before = (await app.calls("mon_probe")).map((c) => (c.args as any).target);
    await page.click(".mon [data-a=refresh]");
    await expect.poll(async () => (await app.calls("mon_probe")).length).toBeGreaterThan(before.length);
    const after = (await app.calls("mon_probe")).slice(before.length).map((c) => (c.args as any).target);
    expect(after).toEqual(["id:h5"]);
    await prod.locator("[data-fold]").click();
    await expect(prod.locator(".mon-card")).toHaveCount(2);
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
