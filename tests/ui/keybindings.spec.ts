import { test, expect } from "./fixtures";

test("assign, reject conflicts, clear and restore shortcuts", async ({ app, page }) => {
  await app.view("settings");
  const first = page.locator('[data-keybinding="view.1"]');
  await first.click();
  await page.keyboard.press("Control+Alt+KeyY");
  await expect(first).toHaveText("Ctrl+Alt+Y");
  const second = page.locator('[data-keybinding="view.2"]');
  await second.click();
  await page.keyboard.press("Control+Alt+KeyY");
  await expect(page.locator('[data-keybinding-status="view.2"]')).toContainText("Уже назначено");
  await page.keyboard.press("Escape");
  await expect(second).toHaveText("Не назначено");
  await page.locator('[name="ai_host"]').focus();
  await page.keyboard.press("Control+Shift+Digit2");
  await expect(page.locator('#sidebar [data-view="settings"]')).toHaveClass(/active/);
  await page.keyboard.press("Control+Alt+KeyY");
  await expect(page.locator('#sidebar [data-view="terminal"]')).toHaveClass(/active/);
  await app.view("settings");
  await page.locator("[data-keybindings-reset]").click();
  await expect(second).toHaveText("Ctrl+Shift+2");
});

test("kind navigation works from the filter and the logs shortcut opens logs", async ({ app, page }) => {
  await app.view("k8s");
  await page.locator(".ctx-item", { has: page.locator(".ctx-name", { hasText: "prod-eu" }) }).click();
  const rows = page.locator(".k8s-main .table-wrap tbody tr:not(.skeleton-row)");
  await expect(rows).toHaveCount(10);
  await page.locator(".k8s-bar .filter").focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.locator(".kind-item.active")).not.toHaveText("Pods");
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.locator(".kind-item.active")).toHaveText("Pods");
  await expect(rows).toHaveCount(10);
  await page.locator(".k8s-main .table-wrap").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ArrowDown");
  await expect(rows.first()).toHaveClass(/cur/);
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveClass(/cur/);
  await page.keyboard.press("Control+Alt+KeyL");
  await expect(page.locator(".drawer .dtab.active")).toHaveText("Логи");
  await app.called("k8s_logs_start");
  await page.keyboard.press("Control+Alt+KeyF");
  await expect(page.locator("dialog[open]")).toBeVisible();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.locator(".kind-item.active")).toHaveText("Pods");
});

// A reassigned terminal shortcut must switch views without also creating a terminal tab.
test("app assignments take precedence over fixed terminal actions", async ({ app, page }) => {
  await app.view("settings");
  const button = page.locator('[data-keybinding="view.2"]');
  await button.click();
  await page.keyboard.press("Control+Shift+KeyP");
  await expect(page.locator(".palette-backdrop")).toHaveCount(0);
  await expect(page.locator('[data-keybinding-status="view.2"]')).toContainText("Палитра команд");
  await page.keyboard.press("Control+Shift+KeyT");
  await expect(button).toHaveText("Ctrl+Shift+T");
  await app.view("terminal");
  const count = await page.locator(".tabs .tab").count();
  await page.locator(".term-host:not([hidden]) .xterm").first().click();
  await page.keyboard.press("Control+Shift+KeyT");
  await expect(page.locator('#sidebar [data-view="k8s"]')).toHaveClass(/active/);
  await expect(page.locator(".tabs .tab")).toHaveCount(count);
});

test("a macOS terminal assignment overrides a built-in tab shortcut", async ({ app, page }) => {
  await page.evaluate(() => Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }));
  await app.view("settings");
  // Settings were mounted at startup; refresh the binding list after changing the test platform.
  await page.evaluate(() => window.dispatchEvent(new Event("keybindings-changed")));
  const button = page.locator('[data-keybinding="terminal.line-start"]');
  await button.click();
  await page.keyboard.press("Control+Shift+KeyT");
  await expect(button).toHaveText("Ctrl+Shift+T");
  await app.view("terminal");
  const tabs = await page.locator(".tabs .tab").count();
  await page.locator(".pane-term:visible").click();
  const before = (await app.calls("pty_write")).length;
  await page.keyboard.press("Control+Shift+KeyT");
  await expect.poll(async () => (await app.calls("pty_write")).slice(before).map(c => c.args.data).join("")).toBe("\x01");
  await expect(page.locator(".tabs .tab")).toHaveCount(tabs);
});

test("project actions are opt-in, work from the editor and protect unsaved files", async ({ app, page }) => {
  await app.view("settings");
  const next = page.locator('[data-keybinding="code.next-project"]');
  await expect(next).toHaveText("Не назначено");
  await next.click();
  await page.keyboard.press("Control+Alt+KeyN");
  await page.locator('[data-keybinding="code.prev-project"]').click();
  await page.keyboard.press("Control+Alt+KeyP");
  await app.view("code");
  for (const path of ["/home/demo/projects/infra/helm", "/home/demo/projects/infra"]) {
    await page.evaluate(path => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path } })), path);
    await expect(page.locator(".code-proj-chip.active")).toContainText(path.endsWith("helm") ? "helm" : "infra");
  }
  await page.locator('.ct-file[data-f$="/README.md"]').click();
  await page.locator(".cm-content").click();
  await page.keyboard.type("draft");
  await page.keyboard.press("Control+Alt+KeyN");
  await expect(page.locator("dialog[open]")).toContainText("Несохранённых файлов");
  await page.keyboard.press("Escape");
  await expect(page.locator(".code-proj-chip.active")).toContainText("infra");
  await expect(page.locator(".cm-content")).toContainText("draft");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+KeyS");
  await expect(page.locator(".code-tab.dirty")).toHaveCount(0);
  await page.keyboard.press("Control+Alt+KeyN");
  await expect(page.locator(".code-proj-chip.active")).toContainText("helm");
  await page.keyboard.press("Control+Alt+KeyP");
  await expect(page.locator(".code-proj-chip.active")).toContainText("infra");
  await app.view("settings");
  await next.click();
  await page.keyboard.press("Escape");
  await app.view("code");
  await page.keyboard.press("Control+Alt+KeyN");
  await expect(page.locator(".code-proj-chip.active")).toContainText("infra");
  await page.keyboard.press("Control+Shift+KeyP");
  await page.locator(".palette-q").fill("Перейти в проект helm");
  await page.keyboard.press("Enter");
  await expect(page.locator(".code-proj-chip.active")).toContainText("helm");
});
