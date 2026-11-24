import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

test.beforeEach(async ({ app, page }) => {
  await app.view("code");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: "/home/demo/projects/infra" } })));
  await expect(page.locator('.ct-file[data-f$="/main.tf"]')).toBeVisible();
});
const file = (page: Page, name: string) => page.locator(`.ct-file[data-f$="/${name}"]`);

test("preview replacement, pinning and dirty files", async ({ page }) => {
  await file(page, "main.tf").click();
  await file(page, "README.md").click();
  await expect(page.locator('.code-tab')).toHaveCount(1);
  await expect(page.locator('.code-tab.preview')).toContainText("README.md");
  await page.locator('.code-tab').dblclick();
  await file(page, "main.tf").click();
  await expect(page.locator('.code-tab')).toHaveCount(2);
  await page.locator('.cm-content').click();
  await page.keyboard.type("# edit");
  await file(page, "outputs.tf").click();
  await expect(page.locator('.code-tab')).toHaveCount(3);
  await expect(page.locator('.code-tab.dirty')).toContainText("main.tf");
});

test("two editor groups keep independent files and undo history", async ({ page }) => {
  await file(page, "README.md").click();
  await page.keyboard.press('Control+Backslash');
  await file(page, "outputs.tf").click();
  await expect(page.locator('.code-editor-group')).toHaveCount(2);
  const first = page.locator('.code-editor-group').nth(0).locator('.cm-content');
  const second = page.locator('.code-editor-group').nth(1).locator('.cm-content');
  await first.click(); await page.keyboard.type('LEFT');
  await second.click(); await page.keyboard.type('RIGHT');
  await expect(first).toContainText('LEFT');
  await expect(second).toContainText('RIGHT');
  await page.keyboard.press('Control+KeyZ');
  await expect(second).not.toContainText('RIGHT');
  await expect(first).toContainText('LEFT');
});

test("VS Code search, quick open and tab shortcuts", async ({ page }) => {
  await file(page, "README.md").dblclick();
  await page.keyboard.press('Control+Shift+KeyF');
  await expect(page.locator('.code-find')).toBeVisible();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+KeyP');
  await page.getByRole('textbox', { name: 'Найти файл', exact: true }).fill('outputs.tf');
  await expect(page.locator('.code-quick-open button').first()).toContainText('outputs.tf');
  await page.keyboard.press('Enter');
  await expect(page.locator('.code-tab.active')).toContainText('outputs.tf');
  await page.keyboard.press('Control+Tab');
  await expect(page.locator('.code-tab.active')).toContainText('README.md');
});

test("two terminals preserve sessions when switching and hiding", async ({ app, page }) => {
  await page.locator('.code-status [data-a=console]').click();
  await expect(page.locator('.cc-session')).toHaveCount(1);
  await page.locator('[data-a=cc-add]').click();
  await expect(page.locator('.cc-session')).toHaveCount(2);
  const spawned = (await app.calls('pty_spawn')).length;
  await page.locator('.cc-select').selectOption('0');
  await expect(page.locator('.cc-session').nth(0)).toBeVisible();
  await page.locator('.cc-select').selectOption('1');
  await expect(page.locator('.cc-session').nth(1)).toBeVisible();
  await page.locator('.code-status [data-a=console]').click();
  await page.locator('.code-status [data-a=console]').click();
  expect((await app.calls('pty_spawn')).length).toBe(spawned);
});

test("a slow earlier file cannot replace the latest navigation", async ({ page }) => {
  await page.evaluate(() => {
    (window as any).__DEMO_OVERRIDES.code_read = (args: any) => new Promise((resolve) => {
      setTimeout(() => resolve({ text: args.path, mtime: 1 }), args.path.endsWith('README.md') ? 350 : 10);
    });
  });
  await file(page, 'README.md').click();
  await file(page, 'outputs.tf').click();
  await expect(page.locator('.code-tab.active')).toContainText('outputs.tf');
  await page.waitForTimeout(450);
  await expect(page.locator('.code-tab')).toHaveCount(1);
  await expect(page.locator('.code-tab.active')).toContainText('outputs.tf');
});
