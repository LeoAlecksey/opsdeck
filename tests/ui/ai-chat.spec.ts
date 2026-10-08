import { test, expect } from "./fixtures";

const LOCAL = "OpsDeck AI (локальный)";

test.describe("local AI in the AI panel (from feedback)", () => {
  test.beforeEach(async ({ app, page }) => {
    await app.view("terminal");
    await page.locator("[data-act=ai]").click();
    await page.selectOption(".ai-provider", LOCAL);
    await expect(page.locator(".ai-chat")).toBeVisible();
  });

  test("it is in the same list as Claude, Codex, Gemini…", async ({ app, page }) => {
    const options = await page.locator(".ai-provider option").allTextContents();
    expect(options).toEqual(expect.arrayContaining(["Claude Code", "Codex", "Gemini", LOCAL]));
    // no CLI started for it
    expect((await app.calls("pty_spawn")).map((c) => (c.args as any).req.program)).not.toContain("");
    // the choice is the default agent everywhere
    await app.view("settings");
    await expect(page.locator(".ai-agent-sel")).toHaveValue(LOCAL);
  });

  test("an answer streams in; a command goes into the terminal on a click, without Enter", async ({ app, page }) => {
    const input = page.locator(".ai-chat textarea");
    await input.fill("почему поды перезапускаются?");
    await input.press("Enter");
    await expect(page.locator(".ai-msg.user")).toContainText("почему поды");
    const answer = page.locator(".ai-msg.assistant").last();
    await expect(answer.locator(".ai-code code")).toHaveText("kubectl get pods -A | grep -v Running");
    await expect(answer).toContainText("kubectl describe pod");
    const chat = await app.called("ai_chat");
    expect((chat.args as any).messages).toEqual([{ role: "user", content: "почему поды перезапускаются?" }]);
    expect(chat.args).toHaveProperty("cwd");
    expect(chat.args).toHaveProperty("shell");
    // a follow-up carries the conversation
    await expect(page.locator("[data-c=send]")).toHaveText("Отправить");
    const writes = (await app.calls("pty_write")).length;
    await answer.locator("[data-c=insert]").click();
    await expect.poll(async () => (await app.calls("pty_write")).slice(writes).map((c) => (c.args as any).data).join("")).toBe("\x1b[200~kubectl get pods -A | grep -v Running\x1b[201~");
    await input.fill("а дальше?");
    await input.press("Enter");
    await expect.poll(async () => ((await app.calls("ai_chat")).at(-1)!.args as any).messages.length).toBe(3);
  });

  test("errors are shown; «Новый» starts over", async ({ page }) => {
    const input = page.locator(".ai-chat textarea");
    await input.fill("ошибка");
    await input.press("Enter");
    await expect(page.locator(".ai-msg.assistant.error")).toContainText("не установлен");
    await page.locator("[data-c=clear]").click();
    await expect(page.locator(".ai-msg")).toHaveCount(0);
  });

  test("«⇢ в AI» puts the selection into the question box", async ({ page }) => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("send-to-ai", { detail: "Error: ImagePullBackOff" })));
    await expect(page.locator(".ai-chat textarea")).toHaveValue("Error: ImagePullBackOff");
  });

  test("notes send the text itself to the local AI", async ({ app, page }) => {
    await app.view("notes");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-note", { detail: { path: (window as any).__DEMO_NOTE } })));
    const btn = page.locator("[data-a=mention]");
    await expect(btn).toHaveText(`@ ${LOCAL}`);
    await btn.click();
    await expect(page.locator(".ai-chat textarea")).toHaveValue(/Перезапуск воркера/);
  });
});
