import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

const pane = (page: Page, side: "a" | "b") => page.locator(`.fx2-pane[data-side="${side}"]`);
const rows = (page: Page, side: "a" | "b") => pane(page, side).locator("tbody tr:not(.up)");
const row = (page: Page, side: "a" | "b", name: string) => pane(page, side).locator(`tbody tr[data-name="${name}"]`);

test.describe("files on hosts (#78)", () => {
  test.beforeEach(async ({ app }) => { await app.view("sftp"); });

  test("the left pane is this machine, the right one a host; both list their folder", async ({ app, page }) => {
    await expect(pane(page, "a").locator(".fx2-host")).toHaveValue("local");
    expect((await app.called("fs_list")).args).toMatchObject({ path: "~" });
    await expect(rows(page, "a")).toHaveCount(3);

    await pane(page, "b").locator(".fx2-host").selectOption("id:h1");
    expect((await app.called("sftp_list")).args).toEqual({ target: "id:h1", path: "" });
    await expect(pane(page, "b").locator(".fx2-path")).toHaveValue("/srv");
    // ссылка показывает, куда ведёт, у папки нет размера
    await expect(row(page, "b", "current")).toContainText("→ releases/7");
    await expect(row(page, "b", "dump 1.sql")).toContainText("1.0 MB");
    await expect(pane(page, "b").locator(".fx2-status")).toHaveText("3 объектов");
  });

  test("a double click walks into a folder, ↑ goes back, a wrong path shows the sftp error", async ({ app, page }) => {
    await pane(page, "b").locator(".fx2-host").selectOption("alias:monitoring");
    await expect(rows(page, "b")).toHaveCount(3);
    await row(page, "b", "releases").dblclick();
    await expect(pane(page, "b").locator(".fx2-path")).toHaveValue("/srv/releases");
    await expect(rows(page, "b")).toHaveCount(2);
    await pane(page, "b").locator("[data-a=up]").click();
    await expect(pane(page, "b").locator(".fx2-path")).toHaveValue("/srv");

    await pane(page, "b").locator(".fx2-path").fill("/nope");
    await pane(page, "b").locator(".fx2-path").blur();
    await expect(pane(page, "b").locator(".fx2-status")).toContainText("No such file or directory");
    expect(await rows(page, "b").count()).toBe(0);
  });

  test("selection goes one way with →, the other with ←, and host to host uses scp -3", async ({ app, page }) => {
    await pane(page, "b").locator(".fx2-host").selectOption("id:h1");
    await expect(rows(page, "b")).toHaveCount(3);

    // своя машина → хост
    await row(page, "a", "notes.md").click();
    await page.locator("[data-a=to-b]").click();
    expect((await app.called("sftp_put")).args).toEqual({ target: "id:h1", local: ["~/notes.md"], remoteDir: "/srv" });
    await expect(page.locator(".toast").last()).toContainText("Скопировано: 1");

    // хост → своя машина, два объекта через Ctrl+клик
    await row(page, "b", "dump 1.sql").click();
    await row(page, "b", "releases").click({ modifiers: ["Control"] });
    await page.locator("[data-a=to-a]").click();
    expect((await app.called("sftp_get")).args).toEqual({ target: "id:h1", remote: ["/srv/dump 1.sql", "/srv/releases"], localDir: "~" });

    // хост → хост: оба соединения ведёт OpsDeck
    await pane(page, "a").locator(".fx2-host").selectOption("alias:monitoring");
    await expect(rows(page, "a")).toHaveCount(3);
    await row(page, "a", "dump 1.sql").click();
    await page.locator("[data-a=to-b]").click();
    expect((await app.called("sftp_between")).args).toEqual({ fromTarget: "alias:monitoring", paths: ["/srv/dump 1.sql"], toTarget: "id:h1", toDir: "/srv" });
  });

  // перетаскивание мышью между панелями (из пожеланий)
  test("dragging a row to the other pane copies it there", async ({ app, page }) => {
    await pane(page, "b").locator(".fx2-host").selectOption("id:h1");
    await expect(rows(page, "b")).toHaveCount(3);
    const src = row(page, "a", "notes.md");
    const a = (await src.boundingBox())!;
    const b = (await pane(page, "b").locator(".fx2-body").boundingBox())!;

    await page.mouse.move(a.x + 40, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + 60, a.y + a.height / 2 + 8, { steps: 3 });
    // ghost и подсветка панели-приёмника
    await expect(page.locator(".fx2-ghost")).toContainText("notes.md");
    await page.mouse.move(b.x + b.width / 2, b.y + 80, { steps: 6 });
    await expect(pane(page, "b")).toHaveClass(/drop/);
    await page.mouse.up();

    expect((await app.called("sftp_put")).args).toEqual({ target: "id:h1", local: ["~/notes.md"], remoteDir: "/srv" });
    await expect(page.locator(".fx2-ghost")).toHaveCount(0);
    await expect(pane(page, "b")).not.toHaveClass(/drop/);
  });

  test("both panes local: nothing is sent, the hint says where to copy instead", async ({ app, page }) => {
    await row(page, "a", "notes.md").click();
    await page.locator("[data-a=to-b]").click();
    await expect(page.locator(".toast").last()).toContainText("копируются в IDE");
    expect(await app.calls("sftp_put")).toHaveLength(0);
  });

  test("create, rename and delete on a host", async ({ app, page }) => {
    await pane(page, "b").locator(".fx2-host").selectOption("id:h1");
    await expect(rows(page, "b")).toHaveCount(3);

    await pane(page, "b").locator("[data-a=mkdir]").click();
    await page.locator("dialog.ask input").fill("release-8");
    await page.locator("dialog.ask button[value=ok]").click();
    expect((await app.called("sftp_mkdir")).args).toEqual({ target: "id:h1", path: "/srv/release-8" });

    await row(page, "b", "dump 1.sql").click();
    await pane(page, "b").locator("[data-a=ren]").click();
    await page.locator("dialog.ask input").fill("dump-old.sql");
    await page.locator("dialog.ask button[value=ok]").click();
    expect((await app.called("sftp_rename")).args).toEqual({ target: "id:h1", from: "/srv/dump 1.sql", to: "/srv/dump-old.sql" });

    await row(page, "b", "releases").click();
    await pane(page, "b").locator("[data-a=del]").click();
    await page.locator("dialog.ask button[value=ok]").click();
    expect((await app.called("sftp_delete")).args).toEqual({ target: "id:h1", path: "/srv/releases", dir: true });
  });
});
