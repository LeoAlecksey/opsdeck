import { expect, test } from "./fixtures";

const PROJ = "/home/demo/projects/infra";

async function openProject(app: any, page: any, path = PROJ) {
  await app.view("code");
  await page.evaluate((p: string) => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: p } })), path);
  await expect(page.locator(".code-tree")).toContainText("main.tf");
}

test.describe("IDE tree: rename, copy, delete", () => {
  test("rename asks for a name and keeps the open tab on the file", async ({ app, page }) => {
    await openProject(app, page);
    await page.evaluate((p) => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: p + "/outputs.tf" } })), PROJ);
    await expect(page.locator(".code-tab", { hasText: "outputs.tf" })).toBeVisible();
    await page.locator('.ct-file[data-f$="/outputs.tf"]').click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Переименовать" }).click();
    await page.locator("dialog.ask input").fill("exports.tf");
    await page.locator("dialog.ask button[value=ok]").click();
    expect((await app.called("code_rename")).args).toEqual({ root: PROJ, from: `${PROJ}/outputs.tf`, to: `${PROJ}/exports.tf` });
    await expect(page.locator(".code-tab", { hasText: "exports.tf" })).toBeVisible();
    await expect(page.locator(".code-tab", { hasText: "outputs.tf" })).toHaveCount(0);
  });

  test("a name with a slash is refused", async ({ app, page }) => {
    await openProject(app, page);
    await page.locator('.ct-file[data-f$="/outputs.tf"]').click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Переименовать" }).click();
    await page.locator("dialog.ask input").fill("../x.tf");
    await page.locator("dialog.ask button[value=ok]").click();
    expect(await app.calls("code_rename")).toHaveLength(0);
  });

  test("copy, then paste into a folder; a taken name gets «копия»", async ({ app, page }) => {
    await openProject(app, page);
    await page.locator('.ct-file[data-f$="/outputs.tf"]').click({ button: "right" });
    await page.locator(".ctx-item", { hasText: /^Копировать$/ }).click();
    // paste next to the file: the name is taken
    await page.locator('.ct-file[data-f$="/outputs.tf"]').click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Вставить" }).click();
    expect((await app.called("code_copy")).args).toEqual({ root: PROJ, from: `${PROJ}/outputs.tf`, to: `${PROJ}/outputs копия.tf` });
    // into a folder: the original name
    await page.locator(".ct-dir[data-p$='/helm'] > .ct-row").click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Вставить" }).click();
    await expect.poll(async () => (await app.calls("code_copy")).at(-1)?.args.to).toBe(`${PROJ}/helm/outputs.tf`);
  });

  test("delete asks first and closes the file's tab", async ({ app, page }) => {
    await openProject(app, page);
    await page.evaluate((p) => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: p + "/outputs.tf" } })), PROJ);
    await expect(page.locator(".code-tab", { hasText: "outputs.tf" })).toBeVisible();
    await page.locator('.ct-file[data-f$="/outputs.tf"]').click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Удалить файл" }).click();
    await expect(page.locator("dialog.ask")).toContainText("Корзины нет");
    await page.locator("dialog.ask button[value=cancel]").click();
    expect(await app.calls("code_delete")).toHaveLength(0);
    await page.locator('.ct-file[data-f$="/outputs.tf"]').click({ button: "right" });
    await page.locator(".ctx-item", { hasText: "Удалить файл" }).click();
    await page.locator("dialog.ask button[value=ok]").click();
    expect((await app.called("code_delete")).args).toEqual({ root: PROJ, path: `${PROJ}/outputs.tf` });
    await expect(page.locator(".code-tab", { hasText: "outputs.tf" })).toHaveCount(0);
  });
});

test.describe("IDE keys on the Russian layout", () => {
  test("Ctrl+F opens the search, Ctrl+S saves (physical keys, not letters)", async ({ app, page }) => {
    await openProject(app, page);
    await page.evaluate((p) => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: p + "/main.tf" } })), PROJ);
    await expect(page.locator(".cm-content")).toContainText('module "cluster"');
    await page.locator(".cm-content").click();
    const press = (key: string, code: string) => page.evaluate(([k, c]) => {
      const t = document.querySelector(".cm-content")!;
      t.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: c, ctrlKey: true, bubbles: true, cancelable: true }));
    }, [key, code]);
    await press("а", "KeyF");
    await expect(page.locator(".cm-search")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.type("# changed\n");
    await press("ы", "KeyS");
    await app.called("code_write");
  });

  test("Ctrl+F with the focus in the tree also opens the search", async ({ app, page }) => {
    await openProject(app, page);
    await page.evaluate((p) => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: p + "/main.tf" } })), PROJ);
    await expect(page.locator(".cm-content")).toContainText('module "cluster"');
    await page.locator(".ct-dir[data-p$='/helm'] > .ct-row").click();
    await page.keyboard.press("Control+KeyF");
    await expect(page.locator(".cm-search")).toBeVisible();
  });
});

test.describe("IDE console follows the project", () => {
  test("opening another folder types cd into the idle shell", async ({ app, page }) => {
    await openProject(app, page);
    await page.getByRole("button", { name: "▭ консоль" }).click();
    await expect(page.locator(".code-console")).toBeVisible();
    await app.called("pty_spawn");
    await page.evaluate((p) => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: p + "/helm" } })), PROJ);
    await expect.poll(async () => (await app.calls("pty_write")).map((c) => c.args.data).join("")).toContain(`cd -- ${PROJ}/helm\r`);
    await expect(page.locator(".cc-cwd")).toHaveText(`${PROJ}/helm`);
  });

  test("a busy console is left alone", async ({ app, page }) => {
    await openProject(app, page);
    await page.getByRole("button", { name: "▭ консоль" }).click();
    await app.called("pty_spawn");
    // OSC 133: a prompt, a typed command and its output have started → a program is running
    const id = (await app.calls("pty_spawn")).at(-1)!.args.req as { id: string };
    const osc = (s: string) => btoa(`\x1b]133;${s}\x07`);
    for (const m of ["A", "B", "E;" + btoa("sleep 100"), "C"]) await app.emit(`pty-data-${id.id}`, osc(m));
    await page.evaluate((p) => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: p + "/helm" } })), PROJ);
    await expect(page.locator(".toast, #toasts")).toContainText("sleep 100");
    expect((await app.calls("pty_write")).map((c) => c.args.data).join("")).not.toContain("cd --");
  });
});

test.describe("IDE → AI", () => {
  test("the project context goes to the AI panel", async ({ app, page }) => {
    await openProject(app, page);
    let sent = "";
    await page.evaluate(() => window.addEventListener("send-to-ai", (e) => { (window as any).__sent = (e as CustomEvent<string>).detail; }));
    await page.getByRole("button", { name: "⇢ AI ▾" }).click();
    await page.locator(".ctx-item", { hasText: "О проекте" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__sent ?? "")).toContain("Проект «infra»");
    sent = await page.evaluate(() => (window as any).__sent);
    expect(sent).toContain("feature/monitoring");
    expect(sent).toContain("main.tf");
  });
});
