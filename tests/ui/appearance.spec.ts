import { test, expect } from "./fixtures";

test.use({ demo: { lang: "auto" } });
test("appearance persists, follows the system and keeps terminal scheme separate", async ({ app, page }) => {
  await app.view("settings");
  const scheme = await page.locator(".term-theme").inputValue();
  await page.locator(".app-appearance").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-appearance", "light");
  await expect(page.locator(".term-theme")).toHaveValue(scheme);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-appearance", "light");
  await app.view("settings");
  await page.locator(".app-appearance").selectOption("system");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-appearance", "light");
});
test("settings explanations expand and wiki opens in the system browser", async ({ app, page }) => {
  await app.view("settings");
  const explanation = page.locator(".settings-explanation").first();
  await expect(explanation.locator("p")).toBeHidden();
  await explanation.locator("summary").click();
  await expect(explanation.locator("p")).toBeVisible();
  await page.locator(".settings-wiki").click();
  expect((await app.called("open_external")).args.url).toBe("https://leoalecksey.github.io/opsdeck/wiki/");
});
test("both IDE groups and hidden files switch theme without losing edits", async ({ app, page }) => {
  await app.view("code");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: "/home/demo/projects/infra" } })));
  await page.locator('.ct-file[data-f$="/README.md"]').dblclick();
  await page.locator('.ct-file[data-f$="/main.tf"]').dblclick();
  await page.keyboard.press("Control+Backslash");
  await page.locator('.ct-file[data-f$="/outputs.tf"]').click();
  const content = page.locator(".code-editor-group").nth(1).locator(".cm-content");
  await content.click(); await page.keyboard.type("draft");
  await app.view("settings"); await page.locator(".app-appearance").selectOption("light");
  await app.view("code");
  await expect.poll(() => page.locator(".cm-editor").evaluateAll(els => els.map(el => getComputedStyle(el).backgroundColor))).toEqual(["rgb(247, 249, 252)", "rgb(247, 249, 252)"]);
  await expect(content).toContainText("draft");
  await content.click(); await page.keyboard.press("Control+KeyZ");
  await expect(content).not.toContainText("draft");
  await page.locator(".code-tab", { hasText: "README.md" }).click();
  await expect.poll(() => page.locator(".cm-editor").first().evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgb(247, 249, 252)");
});
test("modules and sidebar scroll on short screens", async ({ app, page }) => {
  await page.setViewportSize({ width: 1000, height: 400 });
  expect(await page.locator("#sidebar").evaluate(el => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === "auto")).toBe(true);
  await page.locator("#sidebar .modules-btn").click();
  expect(await page.locator(".modules-pop").evaluate(el => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === "auto")).toBe(true);
});
