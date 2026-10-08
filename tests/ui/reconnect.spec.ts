import { test, expect } from "./fixtures";
import type { App } from "./fixtures";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
/** what the shell integration prints around a command: prompt, the command, its output, its exit code */
const block = (cmd: string, out: string, code: number) =>
  `\x1b]133;A\x07$ \x1b]133;B\x07${cmd}\r\n\x1b]133;E;${b64(cmd)}\x07\x1b]133;C\x07${out}\r\n\x1b]133;D;${code}\x07`;

async function sshTab(app: App, page: import("@playwright/test").Page) {
  await app.view("ssh");
  await page.locator("tr[data-id=h3] [data-a=connect]").click();
  await expect.poll(async () => (await app.calls("pty_spawn")).map((c) => (c.args as any).req.program)).toContain("ssh");
  return (await app.calls("pty_spawn")).filter((c) => (c.args as any).req.program === "ssh").at(-1)!.args as any;
}

test.describe("reconnect a dropped connection (from feedback)", () => {
  test("an SSH tab stays open when the session ends; ⟳ reconnects in place", async ({ app, page }) => {
    const first = await sshTab(app, page);
    const tabs = await page.locator(".tabs .tab").count();
    await app.emit(`pty-exit-${first.req.id}`, null);
    const bar = page.locator(".pane .reconnect-bar:visible");
    await expect(bar).toContainText("ssh");
    expect(await page.locator(".tabs .tab").count(), "the tab is not closed").toBe(tabs);
    await bar.locator("[data-rc=go]").click();
    await expect(bar).toHaveCount(0);
    await expect.poll(async () => (await app.calls("pty_spawn")).filter((c) => (c.args as any).req.program === "ssh").length).toBe(2);
    const again = (await app.calls("pty_spawn")).filter((c) => (c.args as any).req.program === "ssh").at(-1)!.args as any;
    expect(again.req.args, "the same connection").toEqual(first.req.args);
    expect(again.req.id).not.toBe(first.req.id);
  });

  test("Enter and Ctrl+Shift+R reconnect too; «Закрыть» closes", async ({ app, page }) => {
    const first = await sshTab(app, page);
    await app.emit(`pty-exit-${first.req.id}`, null);
    await expect(page.locator(".reconnect-bar:visible")).toHaveCount(1);
    await page.locator(".pane:has(.reconnect-bar:visible) .xterm-helper-textarea").focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await app.calls("pty_spawn")).filter((c) => (c.args as any).req.program === "ssh").length).toBe(2);
    const second = (await app.calls("pty_spawn")).filter((c) => (c.args as any).req.program === "ssh").at(-1)!.args as any;
    await app.emit(`pty-exit-${second.req.id}`, null);
    await expect(page.locator(".reconnect-bar:visible")).toHaveCount(1);
    await page.keyboard.press("Control+Shift+KeyR");
    await expect.poll(async () => (await app.calls("pty_spawn")).filter((c) => (c.args as any).req.program === "ssh").length).toBe(3);
    const third = (await app.calls("pty_spawn")).filter((c) => (c.args as any).req.program === "ssh").at(-1)!.args as any;
    await app.emit(`pty-exit-${third.req.id}`, null);
    const tabs = await page.locator(".tabs .tab").count();
    await page.locator(".reconnect-bar:visible [data-rc=close]").click();
    await expect(page.locator(".tabs .tab")).toHaveCount(tabs - 1);
  });

  test("ssh typed in a shell: «⟳ Повторить» runs it again", async ({ app, page }) => {
    await app.view("terminal");
    const id = ((await app.called("pty_spawn")).args as any).req.id;
    await app.emit(`pty-data-${id}`, b64(block("ssh deploy@198.51.100.11", "client_loop: send disconnect: Broken pipe", 255)));
    const chip = page.locator(".fail-chip:visible");
    await expect(chip).toContainText("ssh deploy@198.51.100.11");
    const writes = (await app.calls("pty_write")).length;
    await chip.locator("[data-f=retry]").click();
    await expect.poll(async () => (await app.calls("pty_write")).slice(writes).map((c) => (c.args as any).data).join("")).toBe("ssh deploy@198.51.100.11\r");
  });

  test("a failed non-connection command has no retry", async ({ app, page }) => {
    await app.view("terminal");
    const id = ((await app.called("pty_spawn")).args as any).req.id;
    await app.emit(`pty-data-${id}`, b64(block("ls /nope", "ls: cannot access '/nope'", 2)));
    await expect(page.locator(".fail-chip:visible")).toContainText("ls /nope");
    await expect(page.locator(".fail-chip:visible [data-f=retry]")).toBeHidden();
  });
});
