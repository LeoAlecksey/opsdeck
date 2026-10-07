import { test, expect } from "./fixtures";

test.describe("start and modules", () => {
  test("every section opens without errors", async ({ app, page }) => {
    for (const id of ["terminal", "k8s", "web", "alerts", "net", "ssh", "code", "db", "notes", "tasks", "vault", "winbox", "settings"]) {
      await app.view(id);
      await expect(page.locator("section.view:not([hidden])")).toHaveCount(1);
    }
  });

  test.describe("fresh install", () => {
    test.use({ demo: { modules: null } });
    test("starts with the basic set of modules", async ({ app, page }) => {
      const shown = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#sidebar button[data-view]")].filter((b) => !b.hidden).map((b) => b.dataset.view).sort());
      await expect.poll(shown).toEqual(["k8s", "notes", "settings", "ssh", "terminal", "vault"]);
    });
  });

  test("the ⊞ menu turns modules on and off", async ({ app, page }) => {
    await page.click(".modules-btn");
    const db = page.locator('.modules-pop input[data-mod="db"]');
    await db.uncheck();
    await expect(page.locator('#sidebar button[data-view="db"]')).toBeHidden();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("opsdeck.modules")!))).not.toContain("db");
    await db.check();
    await expect(page.locator('#sidebar button[data-view="db"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".modules-pop")).toHaveCount(0);
  });

  test.describe("a module another one needs", () => {
    test.use({ demo: { modules: ["ssh", "notes"] } });
    test("is turned on by itself (SSH opens a terminal tab)", async ({ app, page }) => {
      await expect(page.locator('#sidebar button[data-view="terminal"]')).toBeHidden();
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-terminal", { detail: { program: "ssh", args: ["bastion"], title: "bastion" } })));
      await expect(page.locator('#sidebar button[data-view="terminal"]')).toBeVisible();
      await expect(page.locator('#sidebar button[data-view="terminal"]')).toHaveClass(/active/);
      const spawn = (await app.calls("pty_spawn")).map((c) => (c.args as any).req.program);
      expect(spawn).toContain("ssh");
    });
  });

  test("the command palette finds hosts, notes and sections", async ({ app, page }) => {
    await page.keyboard.press("Control+Shift+KeyP");
    const input = page.locator(".palette input");
    await expect(input).toBeFocused();
    await input.fill("bastion");
    await expect(page.locator(".palette").getByText("bastion").first()).toBeVisible();
    await input.fill("Базы");
    await page.keyboard.press("Enter");
    await expect(page.locator('#sidebar button[data-view="db"]')).toHaveClass(/active/);
  });
});

test.describe("English", () => {
  test.use({ demo: { lang: "en" } });
  test("every section is translated", async ({ app, page }) => {
    const left: Record<string, string[]> = {};
    for (const id of ["terminal", "k8s", "web", "alerts", "net", "ssh", "code", "db", "notes", "tasks", "vault", "winbox", "settings"]) {
      await app.view(id);
      await page.waitForTimeout(300);
      const cyr = await page.locator("section.view:not([hidden])").evaluate((el) => {
        const out: string[] = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const t = n.textContent!.trim();
          // user content (notes, terminal, file names, demo data) is not translated on purpose
          if (/[А-Яа-яЁё]/.test(t) && !n.parentElement?.closest("[data-no-i18n], .xterm, .note-view, .cm-editor, textarea, select, .tree-label, .note-item")) out.push(t);
        }
        for (const e of el.querySelectorAll<HTMLElement>("[title], [placeholder]")) {
          for (const a of ["title", "placeholder"]) {
            const v = e.getAttribute(a);
            if (v && /[А-Яа-яЁё]/.test(v) && !e.closest("[data-no-i18n]")) out.push(`${a}: ${v}`);
          }
        }
        return out;
      });
      if (cyr.length) left[id] = cyr;
    }
    expect(left, "Russian text left in the English UI").toEqual({});
  });
});
