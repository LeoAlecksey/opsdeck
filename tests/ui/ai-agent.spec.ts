import { test, expect } from "./fixtures";

const openNote = async (app: import("./fixtures").App, page: import("@playwright/test").Page) => {
  await app.view("notes");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-note", { detail: { path: (window as any).__DEMO_NOTE } })));
  await expect(page.locator(".note-view")).toContainText("Перезапуск воркера shop");
};

test.describe("default AI agent (from PR #36)", () => {
  test("Claude Code by default: @ goes over the IDE bridge", async ({ app, page }) => {
    await openNote(app, page);
    const btn = page.locator("[data-a=mention]");
    await expect(btn).toHaveText("@ Claude Code");
    await btn.click();
    expect(((await app.called("ide_at_mention")).args as any).filePath).toBe("/home/demo/notes/runbooks/Перезапуск воркера.md");
  });

  test("chosen in Settings: the notes button, the terminal panel and the palette follow", async ({ app, page }) => {
    await app.view("settings");
    await page.selectOption(".ai-agent-sel", "Codex");
    expect(await page.evaluate(() => localStorage.getItem("opsdeck.ai.provider"))).toBe("Codex");
    await app.view("terminal");
    await expect(page.locator(".ai-provider")).toHaveValue("Codex");
    await page.locator("[data-act=ai]").click();
    await expect.poll(async () => (await app.calls("pty_spawn")).map((c) => (c.args as any).req.program)).toContain("codex");
    await openNote(app, page);
    await expect(page.locator("[data-a=mention]")).toHaveText("@ Codex");
  });

  test("another agent gets the note as @path in the AI panel", async ({ app, page }) => {
    await app.view("settings");
    await page.selectOption(".ai-agent-sel", "Gemini");
    await openNote(app, page);
    await page.locator("[data-a=mention]").click();
    await expect.poll(async () => (await app.calls("pty_spawn")).map((c) => (c.args as any).req.program)).toContain("gemini");
    await expect.poll(async () => (await app.calls("pty_write")).map((c) => (c.args as any).data).join(""), { timeout: 5000 })
      .toContain("@/home/demo/notes/runbooks/Перезапуск воркера.md");
    expect(await app.calls("ide_at_mention")).toEqual([]);
  });

  test("Claude without the IDE bridge: falls back to the AI panel", async ({ app, page }) => {
    await page.evaluate(() => { (window as any).__DEMO_OVERRIDES.ide_at_mention = () => { throw "Claude Code не подключён"; }; });
    await openNote(app, page);
    await page.locator("[data-a=mention]").click();
    await expect.poll(async () => (await app.calls("pty_write")).map((c) => (c.args as any).data).join(""), { timeout: 5000 })
      .toContain("@/home/demo/notes/runbooks/");
  });

  test("changing the agent in the panel changes the default", async ({ app, page }) => {
    await app.view("terminal");
    await page.locator("[data-act=ai]").click();
    await page.selectOption(".ai-provider", "Aider");
    await app.view("settings");
    await expect(page.locator(".ai-agent-sel")).toHaveValue("Aider");
  });
});
