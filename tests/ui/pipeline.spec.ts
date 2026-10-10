import { expect, test } from "./fixtures";

const PROJ = "/home/demo/projects/infra";
/** a card by the job's own name (the needs line also mentions other jobs) */
const job = (page: import("@playwright/test").Page, name: string, cls = "") =>
  page.locator(`.pipe-job${cls}`).filter({ has: page.locator(".pipe-name", { hasText: new RegExp(`^${name}( ×\\d+)?$`) }) });

test.describe("IDE: pipeline graph", () => {
  test.beforeEach(async ({ app, page }) => {
    await app.view("code");
    await page.evaluate((p) => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: p } })), PROJ);
    await expect(page.locator(".code-tree")).toContainText("main.tf");
  });

  test("stages, jobs and what runs on main", async ({ page }) => {
    await page.locator("[data-a=pipeline]").click();
    await expect(page.locator(".code-pipe")).toBeVisible();
    // stages in their order, jobs from .gitlab-ci.yml and from the local include
    expect(await page.locator(".pipe-col h4").allTextContents()).toEqual(["build1", "test3", "deploy1"]);
    await expect(job(page, "unit")).toBeVisible();
    await page.locator(".pipe-branch").fill("main");
    await expect(job(page, "deploy-prod", ".manual")).toBeVisible();
    // without the list of changed files a rules:changes job is honestly "unknown"
    await expect(job(page, "docs", ".unknown")).toBeVisible();
    await page.locator(".pipe-changes").fill("docs/install.md");
    await expect(job(page, "docs", ".run")).toBeVisible();
  });

  test("another branch: the prod deploy disappears, the comparison says so", async ({ page }) => {
    await page.locator("[data-a=pipeline]").click();
    await page.locator(".pipe-branch").fill("feature/x");
    await expect(job(page, "deploy-prod", ".skip")).toBeVisible();
    await page.locator(".pipe-cmp").check();
    await page.locator(".pipe-branch2").fill("main");
    await expect(page.locator(".pipe-sum")).toContainText("1 отличий");
    await expect(job(page, "deploy-prod")).toContainText("не запустится → вручную");
  });

  test("a job opens where it is declared, and goes to the AI", async ({ page }) => {
    await page.evaluate(() => window.addEventListener("send-to-ai", (e) => { (window as any).__sent = (e as CustomEvent<string>).detail; }));
    await page.locator("[data-a=pipeline]").click();
    await job(page, "unit").click();
    const box = page.locator(".pipe-detail");
    await expect(box).toContainText(".gitlab/tests.yml:1");
    await expect(box).toContainText("ждёт: build");
    await box.locator("[data-a=open]").click();
    await expect(page.locator(".code-tab", { hasText: "tests.yml" })).toBeVisible();
    await expect(page.locator(".code-pipe")).toBeHidden();
    // «⇢ AI» sends the job with its condition and switches to the terminal, where the AI panel is
    await page.locator("[data-a=pipeline]").click();
    await job(page, "unit").click();
    await page.locator(".pipe-detail [data-a=ai]").click();
    expect(await page.evaluate(() => (window as any).__sent)).toContain("Задача «unit»");
    expect(await page.evaluate(() => (window as any).__sent)).toContain("запустится");
  });

  test("the button is hidden in a project without CI", async ({ app, page }) => {
    await app.override("fs_list", [{ name: "main.tf", dir: false, link: false, size: 10 }]);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path: "/home/demo/projects/plain" } })));
    await expect(page.locator("[data-a=pipeline]")).toBeHidden();
  });
});
