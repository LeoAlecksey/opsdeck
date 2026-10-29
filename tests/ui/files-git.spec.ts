import { test, expect, type App } from "./fixtures";
import type { Page } from "@playwright/test";

// The files panel runs `git status` only when what it depends on has changed (the stamp of the
// shown folders and of the repository), never two at a time, and remembers a folder outside a repository

async function setup(app: App, page: Page) {
  // fake timers from the start: the panel's own timer must be under the fake clock
  await page.clock.install();
  await page.reload();
  await expect(page.locator("#sidebar button[data-view]:visible").first()).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.__stamp = "s1";
    w.__statusMs = 0;
    w.__running = 0;
    w.__maxRunning = 0;
    w.__repo = true;
    w.__DEMO_OVERRIDES.fs_git_stamp = (a: { dirs: string[] }) => ({ repo: w.__stamp, dirs: a.dirs.map(() => "d") });
    w.__DEMO_OVERRIDES.fs_git_status = () => new Promise((resolve) => {
      w.__maxRunning = Math.max(w.__maxRunning, ++w.__running);
      setTimeout(() => {
        w.__running--;
        resolve(w.__repo ? { root: "/home/demo/projects/infra", branch: "main", files: { "main.tf": " M" } } : { root: "", branch: "", files: {} });
      }, w.__statusMs);
    });
  });
  await app.view("terminal");
  await page.locator("[data-act=files]").click();
  await expect(page.locator(".fx-git")).toContainText("main");
}

const statuses = async (app: App) => (await app.calls("fs_git_status")).length;
/** Seconds of the panel's 1-second timer, one by one so that each tick's promises settle. */
async function seconds(page: Page, n: number) {
  for (let i = 0; i < n; i++) {
    await page.clock.runFor(1000);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
  }
}
const set = (page: Page, k: string, v: unknown) => page.evaluate(([k, v]) => { (window as any)[k as string] = v; }, [k, v] as const);

test.describe("files panel: git status", () => {
  test("not run while nothing changed; once after a change", async ({ app, page }) => {
    await setup(app, page);
    const first = await statuses(app);
    await seconds(page, 16);
    expect(await statuses(app), "same stamp: no git status").toBe(first);
    expect((await app.calls("fs_git_stamp")).length, "the cheap check did run").toBeGreaterThanOrEqual(3);

    await set(page, "__stamp", "s2");
    await seconds(page, 6);
    expect(await statuses(app)).toBe(first + 1);
    await seconds(page, 16);
    expect(await statuses(app), "and not again until the next change").toBe(first + 1);
  });

  test("one at a time: a slow status is not joined by another", async ({ app, page }) => {
    await setup(app, page);
    const first = await statuses(app);
    await set(page, "__statusMs", 12000);
    await set(page, "__stamp", "s2");
    await seconds(page, 6);
    expect(await statuses(app)).toBe(first + 1);
    // changes keep coming while it runs
    await set(page, "__stamp", "s3");
    await seconds(page, 10);
    expect(await statuses(app), "no second status while the first runs").toBe(first + 1);
    await seconds(page, 10);
    expect(await statuses(app), "the change made meanwhile is read after it").toBe(first + 2);
    expect(await page.evaluate(() => (window as any).__maxRunning)).toBe(1);
  });

  test("a folder outside a repository is not asked again until ⟳", async ({ app, page }) => {
    await setup(app, page);
    await set(page, "__repo", false);
    await page.locator(".fx-head [data-f=refresh]").click();
    await expect(page.locator(".fx-git")).toHaveText("");
    const n = await statuses(app);
    const stamps = (await app.calls("fs_git_stamp")).length;
    await set(page, "__stamp", "s2");
    await seconds(page, 16);
    expect(await statuses(app), "remembered: not a repository").toBe(n);
    expect((await app.calls("fs_git_stamp")).length, "nothing to check there").toBe(stamps);

    await set(page, "__repo", true);
    await page.locator(".fx-head [data-f=refresh]").click();
    await expect(page.locator(".fx-git")).toContainText("main");
    expect(await statuses(app)).toBe(n + 1);
  });

  test("a command finished in the terminal: git status again, even outside a repository", async ({ app, page }) => {
    await setup(app, page);
    const id = ((await app.called("pty_spawn")).args as any).req.id;
    const command = (cmd: string) => app.emit(`pty-data-${id}`, b64(block(cmd)));

    // an edit deep in a collapsed folder: the stamp of the shown folders stays the same
    const first = await statuses(app);
    await command("sed -i s/old/new/ modules/net/deep/main.tf");
    await seconds(page, 6);
    expect(await statuses(app), "the finished command is the change").toBe(first + 1);
    await seconds(page, 11);
    expect(await statuses(app), "the same command does not count twice").toBe(first + 1);

    // not a repository yet: remembered until a command runs, then asked again
    await set(page, "__repo", false);
    await page.locator(".fx-head [data-f=refresh]").click();
    await expect(page.locator(".fx-git")).toHaveText("");
    const n = await statuses(app);
    await seconds(page, 11);
    expect(await statuses(app)).toBe(n);
    await set(page, "__repo", true);
    await command("git init");
    await seconds(page, 6);
    expect(await statuses(app), "git init in the terminal is noticed without ⟳").toBe(n + 1);
    await expect(page.locator(".fx-git")).toContainText("main");
  });
});

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
/** what the shell integration prints around a finished command (as in reconnect.spec.ts) */
const block = (cmd: string) =>
  `\x1b]133;A\x07$ \x1b]133;B\x07${cmd}\r\n\x1b]133;E;${b64(cmd)}\x07\x1b]133;C\x07\r\n\x1b]133;D;0\x07`;
