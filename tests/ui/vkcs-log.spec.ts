import { test, expect, type App } from "./fixtures";
import type { Page } from "@playwright/test";

const command = "openstack --os-cloud vk-prod --os-project-id 11111111-2222-3333-4444-555555555555 server list -f json";
const entry = { id: 1, revision: 1, timestamp: "2026-11-08T14:05:06+08:00", command, transport: "sdk", phase: "running", exit_code: null };

async function openVkcs(app: App, page: Page) {
  await page.locator(".modules-btn").click();
  await page.locator('.modules-pop input[data-mod="vkcs"]').check();
  await page.keyboard.press("Escape");
  await app.view("vkcs");
}

test.describe("VK Cloud command log", () => {
  test.use({ demo: { modules: ["terminal"], lang: "auto" } });

  test("starts collapsed, receives commands while hidden and copies only the command", async ({ app, page }) => {
    await openVkcs(app, page);
    await app.called("vkcs_status");
    const toggle = page.locator(".vkcs-log-toggle");
    await expect(toggle).toHaveText("Показать лог");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".vkcs-log-panel")).toBeHidden();
    await expect(page.getByRole("separator", { name: "Высота панели лога" })).toBeHidden();
    await app.emit("vkcs-command-log", entry);
    await expect(page.locator(".vkcs-log-status")).toHaveText("Выполняется команд: 1");
    await toggle.click();
    await expect(page.locator(".vkcs-log-row code")).toHaveText(command);
    await expect(page.locator(".vkcs-log-row")).toHaveAttribute("data-transport", "sdk");
    await expect(page.locator(".vkcs-log-row")).toContainText("SDK");
    await expect(page.locator(".vkcs-log-row time")).toHaveAttribute("datetime", entry.timestamp);
    await expect(page.locator(".vkcs-log-row time")).toContainText("2026");
    await expect(toggle).toHaveText("Скрыть лог");
    // Completing a command must not replace the selected command text.
    await page.locator(".vkcs-log-row code").evaluate((el) => {
      const range = document.createRange(); range.selectNodeContents(el);
      window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    });
    await app.emit("vkcs-command-log", { ...entry, revision: 2, phase: "success", exit_code: 0 });
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(command);
    await expect(page.locator(".vkcs-log-row")).toHaveCount(1);
    await expect(page.locator(".vkcs-log-row")).toHaveAttribute("data-phase", "success");
    await expect(page.locator(".vkcs-log-status")).toHaveText("Готово");
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: async (text: string) => { (window as any).__copiedCommand = text; } },
    }));
    await page.getByRole("button", { name: "Копировать команду", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__copiedCommand)).toBe(command);
    const footer = await page.locator(".vkcs-statusbar").boundingBox();
    const view = await page.locator(".page.vkcs").boundingBox();
    expect(Math.abs(footer!.y + footer!.height - view!.y - view!.height)).toBeLessThan(2);
    await page.screenshot({ path: test.info().outputPath("vkcs-command-log.png") });
    await toggle.click();
    await expect(page.locator(".vkcs-log-panel")).toBeHidden();
  });

  test("resizes by dragging and keyboard, remembers height and restarts collapsed", async ({ app, page }) => {
    await openVkcs(app, page);
    await page.locator(".vkcs-log-toggle").click();
    const panel = page.locator(".vkcs-log-panel");
    const handle = page.getByRole("separator", { name: "Высота панели лога" });
    const original = (await panel.boundingBox())!.height;
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 70, { steps: 6 });
    await page.mouse.up();
    expect((await panel.boundingBox())!.height).toBeGreaterThan(original + 60);
    await handle.focus();
    const dragged = (await panel.boundingBox())!.height;
    await page.keyboard.press("ArrowDown");
    expect((await panel.boundingBox())!.height).toBeCloseTo(dragged - 24, 0);
    const saved = await page.evaluate(() => Number(localStorage.getItem("opsdeck.vkcs.logHeight")));
    await app.view("terminal");
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await app.view("vkcs");
    expect((await panel.boundingBox())!.height).toBeCloseTo(saved, 0);
    await page.reload();
    await app.view("vkcs");
    await expect(panel).toBeHidden();
    await page.locator(".vkcs-log-toggle").click();
    expect((await panel.boundingBox())!.height).toBeCloseTo(saved, 0);
    await handle.focus();
    await page.keyboard.press("End");
    await expect(page.locator(".vkcs-body")).toBeVisible();
    expect((await page.locator(".vkcs-body").boundingBox())!.height).toBeGreaterThanOrEqual(99);
    await page.keyboard.press("Home");
    expect((await panel.boundingBox())!.height).toBe(80);
  });

  test("a late history snapshot cannot overwrite live completions", async ({ app, page }) => {
    await page.evaluate(() => {
      (window as any).__DEMO_OVERRIDES.vkcs_command_log = () => new Promise((resolve) => {
        (window as any).__finishLogHistory = resolve;
      });
    });
    await openVkcs(app, page);
    await app.called("vkcs_command_log");
    await expect(page.locator(".vkcs-body")).toContainText("app-1");
    await app.emit("vkcs-command-log", { ...entry, revision: 2, phase: "success", exit_code: 0 });
    await page.evaluate((snapshot) => (window as any).__finishLogHistory([snapshot]), entry);
    await app.called("vkcs_status");
    await page.locator(".vkcs-log-toggle").click();
    await expect(page.locator(".vkcs-log-row")).toHaveCount(1);
    await expect(page.locator(".vkcs-log-row")).toHaveAttribute("data-phase", "success");
    await expect(page.locator(".vkcs-log-status")).toHaveText("Готово");
  });

  test("renders errors as text, keeps history across tabs and limits it to 500 commands", async ({ app, page }) => {
    await openVkcs(app, page);
    await app.called("vkcs_status");
    await app.emit("vkcs-command-log", { ...entry, command: "openstack <img src=x onerror=alert(1)>", phase: "timeout" });
    await page.locator(".vkcs-log-toggle").click();
    await expect(page.locator(".vkcs-log-row code")).toHaveText("openstack <img src=x onerror=alert(1)>");
    await expect(page.locator(".vkcs-log-panel img")).toHaveCount(0);
    await expect(page.locator(".vkcs-log-phase")).toHaveAttribute("title", "Время ожидания истекло");
    await page.locator('.vkcs-tabs [data-t="net"]').click();
    await app.view("terminal"); await app.view("vkcs");
    await expect(page.locator(".vkcs-log-row")).toHaveCount(1);
    await page.evaluate((base) => {
      for (let id = 2; id <= 505; id++) (window as any).__demoEmit("vkcs-command-log", { ...base, id, revision: id, phase: "success", command: `openstack server show ${id}` });
    }, entry);
    await expect(page.locator(".vkcs-log-row")).toHaveCount(500);
    await expect(page.locator(".vkcs-log-row code").first()).toHaveText("openstack server show 6");
    await expect(page.locator(".vkcs-log-row code").last()).toHaveText("openstack server show 505");
  });

  test("an unavailable log does not block the cloud module", async ({ app, page }) => {
    await page.evaluate(() => {
      (window as any).__DEMO_OVERRIDES.vkcs_command_log = () => { throw new Error("history unavailable"); };
    });
    await openVkcs(app, page);
    await expect(page.locator(".vkcs-log-status")).toHaveText("Лог недоступен");
    await expect(page.locator(".vkcs-body")).toContainText("app-1");
  });

  test.describe("English", () => {
    test.use({ demo: { modules: ["terminal"], lang: "en" } });
    test("translates controls and status while preserving the command", async ({ app, page }) => {
      await openVkcs(app, page);
      await app.called("vkcs_status");
      await expect(page.locator(".vkcs-log-toggle")).toHaveText("Show log");
      await app.emit("vkcs-command-log", entry);
      await expect(page.locator(".vkcs-log-status")).toHaveText("Commands running: 1");
      await page.locator(".vkcs-log-toggle").click();
      await expect(page.locator(".vkcs-log-row code")).toHaveText(command);
      await expect(page.getByRole("button", { name: "Copy command", exact: true })).toBeVisible();
      await expect(page.locator(".vkcs-log-toggle")).toHaveText("Hide log");
    });
  });
});
