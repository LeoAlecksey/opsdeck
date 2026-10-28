import { test, expect } from "./fixtures";

// The IDE (CodeMirror, yaml) and the help texts are separate chunks, loaded on first use.
// In the dev server every module is its own request, so "loaded" = the module's file was requested (app.loaded).

test.describe("lazy sections", () => {
  test("the IDE loads on the first open and works", async ({ app, page }) => {
    await app.view("ssh");
    expect(app.loaded("code.ts"), "the IDE is not loaded at startup").toBe(false);
    await page.keyboard.press("Control+Shift+KeyP");
    await page.locator(".palette input").fill("Открыть папку проекта");
    await expect(page.locator(".palette").getByText("Открыть папку проекта")).toHaveCount(0);
    await page.keyboard.press("Escape");

    await app.view("code");
    expect(app.loaded("code.ts")).toBe(true);
    await expect(page.locator("section.view:not([hidden]) .code-side")).toBeVisible();
    await page.keyboard.press("Control+Shift+KeyP");
    await page.locator(".palette input").fill("Открыть папку проекта");
    await expect(page.locator(".palette").getByText("Открыть папку проекта")).toBeVisible();
  });

  test("open-in-code from another section waits for the IDE to load", async ({ app, page }) => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: "/home/demo/projects/infra/main.tf", line: 18 } })));
    await expect(page.locator('#sidebar button[data-view="code"]')).toHaveClass(/active/);
    await expect(page.locator(".cm-content")).toContainText('module "cluster"');
  });

  test.describe("IDE switched off", () => {
    test.use({ demo: { modules: ["terminal", "ssh"] } });
    test("is not loaded at all", async ({ app, page }) => {
      await app.view("ssh");
      await page.waitForTimeout(500);
      expect(app.loaded("code.ts")).toBe(false);
    });
  });

  test.describe("IDE in a separate window", () => {
    test.use({ demo: { win: "pop-code" } });
    test("loads there and works", async ({ app, page }) => {
      await expect(page.locator("section.view:not([hidden]) .code-side")).toBeVisible();
      expect(app.loaded("code.ts")).toBe(true);
      await expect(page.locator("#views .view")).toHaveCount(1);
      await expect(page.locator("section.view:not([hidden]) .view-loading")).toHaveCount(0);
    });
  });

  test("a chunk that fails to load is reported in the section", async ({ app, page }) => {
    await page.route("**/src/modules/code.ts*", (r) => r.abort());
    await page.click('#sidebar button[data-view="code"]');
    await expect(page.locator("section.view:not([hidden]) .err")).toContainText("Не удалось загрузить раздел «IDE: код и git»");
    expect((await app.calls("log_ui")).some((c) => String(c.args.message).startsWith("view code:"))).toBe(true);
  });
});

test.describe("help", () => {
  test("the guide loads on the first click on «!»", async ({ app, page }) => {
    await app.view("ssh");
    expect(app.loaded("help.ts"), "the help texts are not loaded at startup").toBe(false);
    await page.locator("section.view:not([hidden]) .help-btn").first().click();
    await expect(page.locator("dialog.help-dialog h3")).toHaveText("SSH");
    expect(app.loaded("help.ts")).toBe(true);
    await page.locator("dialog.help-dialog [data-close]").click();
    await expect(page.locator("dialog.help-dialog")).toHaveCount(0);

    await app.view("code");
    await page.locator("section.view:not([hidden]) .help-btn").first().click();
    await expect(page.locator("dialog.help-dialog h3")).toHaveText("IDE: код и git");
  });

  test("a help chunk that fails to load is reported", async ({ app, page }) => {
    await page.route("**/src/modules/help.ts*", (r) => r.abort());
    await app.view("ssh");
    await page.locator("section.view:not([hidden]) .help-btn").first().click();
    await expect(page.locator(".toast.err")).toContainText("Не удалось открыть справку");
  });
});
