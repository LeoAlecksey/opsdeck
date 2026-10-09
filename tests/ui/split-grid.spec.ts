import { expect, test } from "./fixtures";

const panes = (page: import("@playwright/test").Page) => page.locator(".term-host:not([hidden]) .pane");
const tabs = (page: import("@playwright/test").Page) => page.locator(".term-main > .tabbar .tabs .tab");

test.describe("split screen: grid, hosts, dragging a tab", () => {
  test.beforeEach(async ({ app }) => { await app.view("terminal"); });

  test("up to six panes: two, then a grid whose last pane takes the free cells", async ({ page }) => {
    await page.keyboard.press("Control+Shift+KeyD");
    await page.keyboard.press("Control+Shift+KeyE");
    await expect(panes(page)).toHaveCount(3);
    await expect(page.locator(".term-host:not([hidden])")).toHaveClass(/grid/);
    const [a, b, c] = await Promise.all([0, 1, 2].map((i) => panes(page).nth(i).boundingBox()));
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(3);      // two on top
    expect(c!.y).toBeGreaterThan(a!.y + 50);           // the third under them
    expect(c!.width).toBeGreaterThan(a!.width * 1.8);   // and as wide as both
    await page.keyboard.press("Control+Shift+KeyD");
    await expect(panes(page)).toHaveCount(4);
    await page.keyboard.press("Control+Shift+KeyD");
    await page.keyboard.press("Control+Shift+KeyD");
    await expect(panes(page)).toHaveCount(6);
    await page.keyboard.press("Control+Shift+KeyD");
    await expect(page.locator(".toast, #toasts")).toContainText("Не больше 6");
    await expect(panes(page)).toHaveCount(6);
  });

  test("a pane with an SSH host chosen in the dialog", async ({ app, page }) => {
    await page.click("[data-act=split-host]");
    const dlg = page.locator("dialog.host-pick");
    await expect(dlg).toBeVisible();
    await dlg.locator(".hp-filter").fill("stage");
    await expect(dlg.locator(".hp-item")).toHaveCount(1);
    await dlg.locator(".hp-item").click();
    expect((await app.called("ssh_connect")).args).toEqual({ id: "h5", alias: null });
    await expect(panes(page)).toHaveCount(2);
    await expect(panes(page).nth(1).locator(".pane-title")).toHaveText("ssh stage-1");
    await expect.poll(async () => (await app.calls("pty_spawn")).map((c) => (c.args as any).req.program)).toContain("ssh");
  });

  test("a tab dragged onto the area becomes a pane on the chosen side; a pane can leave again", async ({ page }) => {
    await page.click("[data-act=new]");
    await expect(tabs(page)).toHaveCount(2);
    await tabs(page).first().click();                      // the target is the active tab
    const t2 = (await tabs(page).nth(1).boundingBox())!;
    const area = (await page.locator(".term-hosts").boundingBox())!;
    await page.mouse.move(t2.x + 20, t2.y + 8);
    await page.mouse.down();
    await page.mouse.move(t2.x + 40, t2.y + 60, { steps: 4 });
    await page.mouse.move(area.x + area.width * 0.9, area.y + area.height * 0.5, { steps: 6 });
    const zone = page.locator(".drop-zone");
    await expect(zone).toBeVisible();
    await expect(zone).toHaveAttribute("data-zone", "right");
    await page.mouse.up();
    await expect(tabs(page)).toHaveCount(1);
    await expect(panes(page)).toHaveCount(2);
    await expect(page.locator(".pane-head").first()).toBeVisible();
    // the second pane goes back to a tab of its own
    await panes(page).nth(1).locator("[data-ph=out]").click();
    await expect(tabs(page)).toHaveCount(2);
    await expect(panes(page)).toHaveCount(1);
  });

  test("dropped on the top edge the panes are stacked", async ({ page }) => {
    await page.click("[data-act=new]");
    await tabs(page).first().click();
    const t2 = (await tabs(page).nth(1).boundingBox())!;
    const area = (await page.locator(".term-hosts").boundingBox())!;
    await page.mouse.move(t2.x + 20, t2.y + 8);
    await page.mouse.down();
    await page.mouse.move(t2.x + 40, t2.y + 60, { steps: 4 });
    await page.mouse.move(area.x + area.width * 0.5, area.y + area.height * 0.1, { steps: 6 });
    await expect(page.locator(".drop-zone")).toHaveAttribute("data-zone", "top");
    await page.mouse.up();
    await expect(panes(page)).toHaveCount(2);
    const [a, b] = await Promise.all([0, 1].map((i) => panes(page).nth(i).boundingBox()));
    expect(b!.y).toBeGreaterThan(a!.y + 50);
    expect(Math.abs(a!.x - b!.x)).toBeLessThan(3);
  });

  test("a click on a tab still switches to it", async ({ page }) => {
    await page.click("[data-act=new]");
    await tabs(page).first().click();
    await expect(tabs(page).first()).toHaveClass(/active/);
    await tabs(page).nth(1).click();
    await expect(tabs(page).nth(1)).toHaveClass(/active/);
    await expect(tabs(page)).toHaveCount(2);
  });
});
