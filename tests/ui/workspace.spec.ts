import { test, expect } from "./fixtures";

const view = (page: import("@playwright/test").Page) => page.locator("section.view:not([hidden])");

test.describe("notes", () => {
  test.beforeEach(async ({ app, page }) => {
    await app.view("notes");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-note", { detail: { path: (window as any).__DEMO_NOTE } })));
    await expect(page.locator(".note-view")).toContainText("Перезапуск воркера shop");
  });

  test("add a tag: it goes to the front matter and the note is saved", async ({ app, page }) => {
    await expect(page.locator(".note-tags")).toContainText("#runbook");
    await page.locator(".tag-in").fill("oncall");
    await page.locator(".tag-in").press("Enter");
    const w = await app.called("note_write");
    expect(w.args.path).toBe("runbooks/Перезапуск воркера.md");
    expect(w.args.content as string).toMatch(/^---\ntags: \[runbook, shop, oncall\]\n---\n/);
  });

  test("editor mode and Ctrl+S", async ({ app, page }) => {
    await page.locator("[data-m=edit]").click();
    const editor = page.locator(".note-editor");
    await expect(editor).toBeVisible();
    await editor.press("End");
    await editor.pressSequentially("\nНовая строка");
    await expect(page.locator("section.view.note-dirty"), "turquoise frame while unsaved").toHaveCount(1);
    await page.keyboard.press("Control+KeyS");
    expect((await app.called("note_write")).args.content as string).toContain("Новая строка");
    await expect(page.locator("section.view.note-dirty"), "the frame goes away after saving").toHaveCount(0);
  });

  test("Ctrl+S and Ctrl+E work in the Russian layout (from feedback)", async ({ app, page }) => {
    const ru = (key: string, code: string) => page.locator(".notes-main").evaluate((el, [k, c]) => {
      const target = document.activeElement && el.contains(document.activeElement) ? document.activeElement : el;
      target.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: c, ctrlKey: true, bubbles: true, cancelable: true }));
    }, [key, code] as const);
    await ru("у", "KeyE");
    const editor = page.locator(".note-editor");
    await expect(editor).toBeVisible();
    await editor.press("End");
    await editor.pressSequentially(" правка");
    await ru("ы", "KeyS");
    expect((await app.called("note_write")).args.content as string).toContain("правка");
    await expect(page.locator("section.view.note-dirty")).toHaveCount(0);
  });

  test("unsaved frame goes all around; the editor has no half focus ring (from feedback)", async ({ page }) => {
    await page.locator("[data-m=edit]").click();
    const editor = page.locator(".note-editor");
    await editor.press("End");
    await editor.pressSequentially("!");
    const frame = await page.locator(".notes-main").evaluate((el) => {
      const s = getComputedStyle(el, "::after");
      return [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth, s.position];
    });
    expect(frame).toEqual(["2px", "2px", "2px", "2px", "absolute"]);
    expect(await editor.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");
    await page.keyboard.press("Control+KeyS");
    await expect(page.locator("section.view.note-dirty")).toHaveCount(0);
    expect(await page.locator(".notes-main").evaluate((el) => getComputedStyle(el, "::after").borderTopWidth)).toBe("0px");
  });

  test("a note with Windows line endings is not 'unsaved' after just viewing it, and keeps them", async ({ app, page }) => {
    await app.override("note_read", "# Attenuator\r\n\r\nWindows line endings.\r\n");
    const open = (path: string) => page.evaluate((p) => window.dispatchEvent(new CustomEvent("open-note", { detail: { path: p } })), path);
    await open("runbooks/attenuator.md");
    await expect(page.locator(".note-view")).toContainText("Windows line endings");
    await open("k8s/Полезные команды kubectl.md");
    await expect(page.locator("dialog.ask"), "no 'unsaved changes' question").toHaveCount(0);
    await page.locator("[data-m=edit]").click();
    await page.locator(".note-editor").press("End");
    await page.locator(".note-editor").pressSequentially("\nx");
    await page.keyboard.press("Control+KeyS");
    expect((await app.called("note_write")).args.content).toBe("# Attenuator\r\n\r\nWindows line endings.\r\n\r\nx");
  });

  test("the vault menu lists vaults", async ({ page }) => {
    await page.locator(".vault-btn").click();
    await expect(page.locator(".vault-menu")).toContainText("work");
  });
});

test.describe("tasks", () => {
  test.beforeEach(async ({ app }) => { await app.view("tasks"); });

  test("grouped by due date, with the badge for overdue + today", async ({ page }) => {
    await expect(page.locator('#sidebar button[data-view="tasks"]')).toHaveAttribute("data-badge", "3");
    await expect(view(page)).toContainText("Просрочено");
    await expect(view(page)).toContainText("Сегодня");
    await expect(page.locator(".tk-check:not(:checked)")).toHaveCount(7);
  });

  test("done and → tomorrow update the line in the note", async ({ app, page }) => {
    const row = page.locator(".tk-row", { hasText: "Обновить сертификат shop.example.com" });
    await row.locator(".tk-check").click();
    expect((await app.called("task_update")).args).toMatchObject({ path: "Задачи.md", line: 3, change: { done: true } });
    const row2 = page.locator(".tk-row", { hasText: "Почистить старые образы" });
    await row2.hover();
    await row2.locator("[data-act=tomorrow]").click();
    await expect.poll(async () => (await app.calls("task_update")).length).toBe(2);
  });

  test("calendar", async ({ page }) => {
    await page.locator("[data-a=cal]").click();
    await expect(page.locator(".cal-grid")).toBeVisible();
    await expect(page.locator(".cal-day.today")).toContainText("Обновить сертификат");
  });
});

test.describe("databases", () => {
  test("structure, double click a table, Ctrl+Enter", async ({ app, page }) => {
    await app.view("db");
    await page.locator('.db-conn[data-id="d1"] > .tree-row').click();
    await expect(page.locator(".db-ro")).toBeVisible();
    await page.locator(".tree-dir[data-id='d1'] .tree-row", { hasText: "public" }).click();
    await page.locator(".db-leaf[data-id='d1']", { hasText: "orders" }).dblclick();
    expect((await app.called("db_query")).args).toMatchObject({ id: "d1", query: "SELECT * FROM public.orders LIMIT 100;" });
    await expect(page.locator(".db-table tbody tr")).toHaveCount(8);
    await page.locator(".db-editor").fill("SELECT count(*) FROM orders;");
    await page.locator(".db-editor").press("Control+Enter");
    await expect.poll(async () => (await app.calls("db_query")).at(-1)?.args.query).toBe("SELECT count(*) FROM orders;");
  });
});

test.describe("IDE", () => {
  test("project tree, terraform file, git panel, save", async ({ app, page }) => {
    await app.view("code");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: "/home/demo/projects/infra" } })));
    await expect(view(page)).toContainText("main.tf");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: "/home/demo/projects/infra/main.tf", line: 18 } })));
    await expect(page.locator(".cm-content")).toContainText('module "cluster"');
    await page.locator("[data-a=git-toggle]").click();
    await expect(view(page)).toContainText("feature/monitoring");
    await expect(page.locator(".cg-commit")).toHaveCount(8);
    await page.locator(".cm-content").click();
    await page.keyboard.type("# changed\n");
    await page.keyboard.press("Control+KeyS");
    await app.called("code_write");
  });
});

test.describe("IDE git graph", () => {
  test("a new branch on the same commit is explained", async ({ app, page }) => {
    await app.override("code_git_log", [
      { hash: "f6a8b54", parents: ["d4c6f32"], refs: ["HEAD -> feature/new", "origin/main", "main"], author: "Alex", time: 1791300000, subject: "cluster: node_count 3 → 4" },
      { hash: "d4c6f32", parents: [], refs: [], author: "Maria", time: 1791200000, subject: "network" },
    ]);
    await app.view("code");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: "/home/demo/projects/infra" } })));
    await page.locator("[data-a=git-toggle]").click();
    await expect(page.locator(".cg-hint")).toContainText("feature/new");
    await expect(page.locator(".cg-hint")).toContainText("создана от main");
  });

  test("no hint once the branch has its own commits", async ({ app, page }) => {
    await app.view("code");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: "/home/demo/projects/infra" } })));
    await page.locator("[data-a=git-toggle]").click();
    await expect(page.locator(".cg-commit")).toHaveCount(8);
    await expect(page.locator(".cg-hint")).toHaveCount(0);
  });

  test("a branch switched in a terminal shows up by itself (from feedback)", async ({ app, page }) => {
    await app.override("code_git_stamp", "ref: refs/heads/feature/monitoring|1|0|1");
    await app.view("code");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: "/home/demo/projects/infra" } })));
    await page.locator("[data-a=git-toggle]").click();
    await expect(page.locator(".cg-branch")).toHaveText("feature/monitoring");
    await expect.poll(async () => (await app.calls("code_git_stamp")).length, { timeout: 6000 }).toBeGreaterThan(0);
    const logs = (await app.calls("code_git_log")).length;
    // `git switch main` in the console
    await page.evaluate(() => {
      const o = (window as any).__DEMO_OVERRIDES;
      o.code_git_stamp = "ref: refs/heads/main|1|0|2";
      o.fs_git_status = { root: "/home/demo/projects/infra", branch: "main", files: {} };
    });
    await expect(page.locator(".cg-branch")).toHaveText("main", { timeout: 6000 });
    expect((await app.calls("code_git_log")).length, "the graph is redrawn").toBeGreaterThan(logs);
    await expect(page.locator(".cg-changes")).toContainText("чисто");
  });
});

test.describe("IDE git on Windows", () => {
  test("git paths C:/… match the project's C:\\… paths; a missing git is reported", async ({ app, page }) => {
    await app.override("fs_git_status", { root: "C:/Users/demo/infra", branch: "main", files: { "main.tf": " M" } });
    await app.override("fs_list", [{ name: "main.tf", dir: false, link: false, size: 10 }]);
    await app.view("code");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: "C:\\Users\\demo\\infra" } })));
    await expect(page.locator(".code-tree .ct-st, [class*=ct-] .ct-st").first()).toHaveText("M");
    await app.override("fs_git_status", { root: "", branch: "", files: {}, error: "git не найден — установите Git (на Windows: Git for Windows) и перезапустите OpsDeck" });
    await page.locator("[data-a=git-toggle]").click();
    await expect(page.locator(".cg-branch")).toHaveText("git недоступен");
  });
});

test.describe("IDE line endings", () => {
  test("a Windows file opens clean and is saved with its own line endings", async ({ app, page }) => {
    await app.override("code_read", { text: "a = 1\r\nb = 2\r\n", mtime: 1 });
    await app.override("code_write", 2);
    await app.view("code");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: "/home/demo/projects/infra/win.tf" } })));
    const tab = page.locator(".code-tab", { hasText: "win.tf" });
    await expect(page.locator(".cm-content")).toContainText("b = 2");
    await expect(tab).not.toHaveClass(/dirty/);
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("c = 3");
    await expect(tab).toHaveClass(/dirty/);
    await page.keyboard.press("Control+KeyS");
    expect((await app.called("code_write")).args.text).toBe("a = 1\r\nb = 2\r\nc = 3");
  });
});

test.describe("settings", () => {
  test.beforeEach(async ({ app }) => { await app.view("settings"); });

  test("local AI: model, acceleration, external server warning", async ({ app, page }) => {
    await page.locator(".ai-model").selectOption("qwen3.5-4b");
    expect((await app.called("ai_select")).args).toEqual({ model: "qwen3.5-4b" });
    await page.locator(".ai-gpu").selectOption("cpu");
    expect((await app.called("ai_set_gpu")).args).toEqual({ on: false });
    await page.locator("input[name=ai_host]").fill("192.0.2.80");
    await page.locator("input[name=ai_model]").fill("qwen3:8b");
    await expect(page.locator(".ai-remote-warn")).toContainText("уходят на сервер http://192.0.2.80:11434");
    await expect(page.locator(".ai-remote-warn")).toContainText("без шифрования");
    await page.locator("input[name=ai_host]").fill("localhost");
    await expect(page.locator(".ai-remote-warn")).toContainText("на этом компьютере");
  });

  test("save sends a new API key once and never shows it back", async ({ app, page }) => {
    await page.locator("input[name=ai_api_key]").fill("sk-demo");
    await view(page).locator("button[type=submit]", { hasText: "Сохранить" }).click();
    const set = await app.called("settings_set");
    expect((set.args as any).settings.ai_api_key).toBe("sk-demo");
    await expect(page.locator("input[name=ai_api_key]")).toHaveValue("");
  });

  test("paths pasted with quotes (Windows 'Copy as path') are cleaned on save", async ({ app, page }) => {
    await page.locator("input[name=winbox_path]").fill('"C:\\Program Files\\WinBox\\winbox64.exe"');
    await view(page).locator("button[type=submit]", { hasText: "Сохранить" }).click();
    expect(((await app.called("settings_set")).args as any).settings.winbox_path).toBe("C:\\Program Files\\WinBox\\winbox64.exe");
  });

  test("terminal font picker", async ({ page }) => {
    await page.locator(".term-font-family").selectOption("Ubuntu Mono");
    expect(await page.evaluate(() => localStorage.getItem("opsdeck.term.fontFamily"))).toBe("Ubuntu Mono");
    await page.locator(".term-font-family").selectOption("__other__");
    await expect(page.locator(".term-font-custom-row")).toBeVisible();
  });
});

test.describe("other sections", () => {
  test("web panels open as tabs", async ({ app, page }) => {
    await app.view("web");
    await expect(page.locator(".card-name")).toHaveCount(3);
    // ⧉ — the panel in its own window (#28: froze on Windows when the command was sync)
    await page.locator(".card", { hasText: "Argo CD" }).locator("[data-act=window]").click();
    expect((await app.called("connector_open")).args).toEqual({ id: "c2" });
    await page.locator(".card", { hasText: "Grafana" }).locator("[data-act=open]").click();
    await app.called("web_embed_show");
  });

  test("a page being created is shown once at a time and not over a dialog (from feedback)", async ({ app, page }) => {
    // the first show creates the page and takes a while; meanwhile the window resizes and a dialog opens
    await page.evaluate(() => {
      const w = window as any;
      w.__embed = { now: 0, max: 0 };
      w.__DEMO_OVERRIDES.web_embed_show = async () => {
        w.__embed.max = Math.max(w.__embed.max, ++w.__embed.now);
        await new Promise((r) => setTimeout(r, 400));
        w.__embed.now--;
      };
    });
    await app.view("web");
    await page.locator(".card", { hasText: "Grafana" }).locator("[data-act=open]").click();
    await app.called("web_embed_show");
    await page.setViewportSize({ width: 1300, height: 860 });
    await page.evaluate(() => window.dispatchEvent(new Event("overlay-open")));
    const hides = (await app.calls("web_embed_hide")).length;
    await expect.poll(async () => (await app.calls("web_embed_hide")).length, { message: "the page that finished showing under a dialog is hidden again" }).toBeGreaterThan(hides);
    expect(await page.evaluate(() => (window as any).__embed.max), "never two web_embed_show at once").toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event("overlay-close")));
    await expect.poll(async () => (await app.calls("web_embed_show")).at(-1)?.args.rect).toMatchObject({ w: expect.any(Number) });
    await expect.poll(() => page.evaluate(() => (window as any).__embed.now)).toBe(0);
    expect(await page.evaluate(() => (window as any).__embed.max)).toBe(1);
  });

  test("＋ opens another panel straight from a tab (two Grafanas, from feedback)", async ({ app, page }) => {
    await app.view("web");
    await page.locator(".card", { hasText: "Grafana" }).locator("[data-act=open]").click();
    await expect.poll(async () => (await app.calls("web_embed_show")).at(-1)?.args.id).toBe("c1");
    await page.locator(".web-pick").click();
    await expect(page.locator(".web-pick-menu")).toBeVisible();
    expect((await app.calls("web_embed_hide")).length, "the native page hides under the menu").toBeGreaterThan(0);
    await page.locator(".web-pick-menu button", { hasText: "Argo CD" }).click();
    await expect(page.locator(".web-pick-menu")).toHaveCount(0);
    await expect(page.locator(".web-tablist .tab.active")).toContainText("Argo CD");
    await expect.poll(async () => (await app.calls("web_embed_show")).at(-1)?.args.id).toBe("c2");
    await expect(page.locator(".web-tablist .tab")).toHaveCount(2);
    // the page never covers the tab bar
    const show = (await app.calls("web_embed_show")).at(-1)!.args as any;
    const bar = await page.locator(".web-tabs").boundingBox();
    expect(show.rect.y).toBeGreaterThanOrEqual(bar!.y + bar!.height - 0.5);
  });

  test("network tools run without a shell", async ({ app, page }) => {
    await app.view("net");
    await page.locator("input[name=target]").fill("example.com");
    await page.locator("[data-pane=tools] button[type=submit]").click();
    const run = await app.called("tool_run");
    expect((run.args as any).req).toMatchObject({ tool: "ping", target: "example.com", count: 4 });
  });

  test("fast tools: output that arrives before the command line is not lost (found by e2e)", async ({ app, page }) => {
    // ping -c 1 127.0.0.1 finishes before tool_run returns: lines and exit come first
    await page.evaluate(() => {
      (window as any).__DEMO_OVERRIDES.tool_run = (a: any) => {
        (window as any).__demoEmit(`tool-line-${a.runId}`, { stream: "out", text: "64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.03 ms" });
        (window as any).__demoEmit(`tool-exit-${a.runId}`, 0);
        return "ping -c 1 127.0.0.1";
      };
    });
    await app.view("net");
    await page.locator("input[name=target]").fill("127.0.0.1");
    await page.locator("[data-pane=tools] button[type=submit]").click();
    const out = page.locator("[data-pane=tools] .output");
    await expect(out).toContainText("64 bytes from 127.0.0.1");
    const text = await out.innerText();
    expect(text.indexOf("$ ping"), text).toBeLessThan(text.indexOf("64 bytes"));
    expect(text.indexOf("64 bytes"), text).toBeLessThan(text.indexOf("завершено"));
    await expect(page.locator("[data-pane=tools] button[type=submit]")).toBeEnabled();
  });

  test("MikroTik: WinBox in one click", async ({ app, page }) => {
    await app.view("winbox");
    await page.locator("[data-a=winbox]").click();
    expect((await app.called("mt_winbox")).args).toEqual({ id: "m1" });
  });
});
