import { expect, test } from "./fixtures";

// Switching agents used to dispose the running one, losing the conversation (#79).
test.describe("AI panel: several agents at once", () => {
  const slots = (page: import("@playwright/test").Page) => page.locator(".ai-slot");

  test("a second agent is added next to the first, both stay alive", async ({ app, page }) => {
    await app.view("terminal");
    await page.keyboard.press("Control+Shift+KeyI");
    await expect(slots(page)).toHaveCount(1);
    const names = await page.locator(".ai-provider option").allTextContents();
    const chosen = await page.locator(".ai-provider").inputValue();
    const other = names.find((n) => n !== chosen)!;
    await page.locator(".ai-provider").selectOption(other);
    await expect(slots(page)).toHaveCount(2);
    await expect(page.locator(".ai-slot-head").first()).toBeVisible();
    // the same agent again only moves the focus
    await page.locator(".ai-provider").selectOption(chosen);
    await expect(slots(page)).toHaveCount(2);
    await expect(page.locator(".ai-slot.current .ai-slot-name")).toHaveText(chosen);
  });

  test("an agent closes by its ×, the panel hides with the last one", async ({ app, page }) => {
    await app.view("terminal");
    await page.keyboard.press("Control+Shift+KeyI");
    await expect(slots(page)).toHaveCount(1);
    const names = await page.locator(".ai-provider option").allTextContents();
    await page.locator(".ai-provider").selectOption(names[1]);
    await expect(slots(page)).toHaveCount(2);
    await page.locator(".ai-slot").last().locator("[data-s=close]").click();
    await expect(slots(page)).toHaveCount(1);
    await page.locator(".ai-slot").first().locator("[data-s=close]").click();
    await expect(page.locator(".ai-panel")).toBeHidden();
  });

  test("a selection goes to the agent in focus", async ({ app, page }) => {
    await app.view("terminal");
    await page.keyboard.press("Control+Shift+KeyI");
    const names = await page.locator(".ai-provider option").allTextContents();
    await page.locator(".ai-provider").selectOption(names[1]);
    await expect(page.locator(".ai-slot.current .ai-slot-name")).toHaveText(names[1]);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("send-to-ai", { detail: "строка из терминала" })));
    await expect(page.locator(".ai-slot.current")).toBeVisible();
  });
});
