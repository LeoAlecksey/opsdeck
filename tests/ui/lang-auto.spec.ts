import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

// The language is not chosen yet (opsdeck.lang is not set): a fresh install follows the system,
// an install from before the language setting stays Russian.
const stored = (page: Page) => page.evaluate(() => localStorage.getItem("opsdeck.lang"));
async function guide(page: Page) {
  await page.locator("section.view:not([hidden]) .help-btn").first().click();
  const h = await page.locator("dialog.help-dialog h3").textContent();
  await page.locator("dialog.help-dialog [data-close]").click();
  return h;
}

test.describe("fresh install, English system", () => {
  test.use({ locale: "en-US", demo: { lang: "auto", modules: null } });

  test("the guide and the interface stay English, also after a restart", async ({ app, page }) => {
    await app.view("terminal");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    expect(await guide(page)).toBe("Terminal & AI");
    expect(await stored(page)).toBe("auto");

    await page.reload();
    await expect(page.locator("#sidebar button[data-view]:visible").first()).toBeVisible();
    await app.view("terminal");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    expect(await guide(page)).toBe("Terminal & AI");
    expect(await stored(page)).toBe("auto");
  });
});

test.describe("fresh install, Russian system", () => {
  test.use({ locale: "ru-RU", demo: { lang: "auto", modules: null } });

  test("Russian interface and guide", async ({ app, page }) => {
    await app.view("terminal");
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    expect(await guide(page)).toBe("Терминал и AI");
  });
});

test.describe("install from before the language setting, English system", () => {
  // opsdeck.modules is there, opsdeck.lang is not
  test.use({ locale: "en-US", demo: { lang: "auto" } });

  test("stays Russian", async ({ app, page }) => {
    await app.view("terminal");
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    expect(await stored(page)).toBe("ru");
  });
});
