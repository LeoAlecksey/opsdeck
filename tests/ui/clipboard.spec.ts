import { test, expect } from "./fixtures";

// Из журнала пользователя: интерфейс зависал ровно на ~4 с — столько arboard ждёт владельца
// выделения на X11. Пока владельцем остаётся само окно, этого ожидания нет, поэтому обычное
// копирование идёт через webview, а бэкенд — запасной путь, если доступ из окна закрыт.
test.describe("копирование", () => {
  // приложение уже открыто фикстурой, поэтому подменяем буфер обмена на живой странице
  const stubClipboard = (page: import("@playwright/test").Page) =>
    page.evaluate(() => {
      (window as any).__copied = [];
      (window as any).__clipboardWorks = true;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            if (!(window as any).__clipboardWorks) throw new Error("denied");
            (window as any).__copied.push(text);
          },
        },
      });
    });

  async function runQueryAndCopyCsv(app: { view: (id: string) => Promise<void> }, page: import("@playwright/test").Page) {
    await app.view("db");
    await page.locator(".db-conn").first().click();
    const editor = page.locator(".db-editor");
    await expect(editor).toBeEnabled();
    await editor.fill("select * from orders limit 8");
    await page.locator("[data-a=run]").click();
    await expect(page.locator("[data-a=csv]")).toBeEnabled();
    await page.locator("[data-a=csv]").click();
    await expect(page.locator(".toast").last()).toContainText("CSV скопирован");
  }

  test("идёт через окно, а не через бэкенд", async ({ app, page }) => {
    await stubClipboard(page);
    await runQueryAndCopyCsv(app, page);
    const copied = await page.evaluate(() => (window as any).__copied as string[]);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain("anna@example.com");
    expect(await app.calls("clip_write")).toHaveLength(0);
  });

  test("если окну копировать нельзя, текст уходит в бэкенд, а не теряется", async ({ app, page }) => {
    await stubClipboard(page);
    await page.evaluate(() => { (window as any).__clipboardWorks = false; });
    await runQueryAndCopyCsv(app, page);
    expect(await page.evaluate(() => (window as any).__copied as string[])).toHaveLength(0);
    expect((await app.called("clip_write")).args.text).toContain("anna@example.com");
  });
});
