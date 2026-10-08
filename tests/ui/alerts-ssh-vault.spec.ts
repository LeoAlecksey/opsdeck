import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

const card = (page: Page, name: string) => page.locator(".al-card", { has: page.locator(".al-name", { hasText: name }) });

test.describe("alerts", () => {
  test.beforeEach(async ({ app }) => { await app.view("alerts"); });

  test("cards, counters and the severity filter", async ({ page }) => {
    await expect(page.locator('#sidebar button[data-view="alerts"]')).toHaveAttribute("data-badge", "5");
    await expect(page.locator(".al-card:visible")).toHaveCount(5);
    await page.locator("[data-sev=crit]").click();
    await expect(page.locator(".al-card:visible")).toHaveCount(1);
    await expect(page.locator(".al-card:visible .al-name")).toHaveText("PodCrashLooping");
    await page.locator("[data-sev=crit]").click();
    await expect(page.locator(".al-card:visible")).toHaveCount(5);
  });

  test("seen, hide such, close a finding, poll now", async ({ app, page }) => {
    await card(page, "PodCrashLooping").locator("[data-a=ack]").click();
    expect((await app.called("alerts_ack")).args).toEqual({ fingerprint: "PodCrashLooping1", acked: true });
    await card(page, "High5xxRate").locator("[data-a=mute]").click();
    expect((await app.called("alerts_mute")).args).toEqual({ source: "Grafana", name: "High5xxRate", muted: true });
    await card(page, "Всплеск ошибок авторизации").locator("[data-a=resolve]").click();
    await app.called("alerts_resolve");
    await expect(card(page, "DiskWillFillIn24h").locator("[data-a=resolve]"), "only AI findings can be closed by hand").toHaveCount(0);
    await page.locator("[data-a=poll]").click();
    await app.called("alerts_poll_now");
    await expect(page.locator(".toast").last()).toContainText("Опрошено");
  });

  test("→ AI sends the alert to the AI panel", async ({ app, page }) => {
    await card(page, "PodCrashLooping").locator("[data-a=ai]").click();
    await expect(page.locator('#sidebar button[data-view="terminal"]')).toHaveClass(/active/);
    await expect(page.locator(".ai-panel")).toBeVisible();
  });

  test("dashboard link opens a Grafana tab", async ({ page }) => {
    await card(page, "PodCrashLooping").locator("[data-url]", { hasText: "Дашборд" }).click();
    await expect(page.locator('#sidebar button[data-view="web"]')).toHaveClass(/active/);
  });
});

test.describe("alerts: a Zabbix source", () => {
  test.use({ demo: { overrides: { alerts_sources: [], alerts_get: { current: [], history: [], firing: 0 }, alerts_test_source: 3 } } });
  test("＋ Zabbix → dialog → save and check", async ({ app, page }) => {
    await app.view("alerts");
    await page.locator("[data-add=zabbix]").click();
    const dlg = page.locator("dialog.conn-dialog");
    await expect(dlg).toBeVisible();
    await expect(dlg.locator("select[name=kind]")).toHaveValue("zabbix");
    await expect(dlg).toContainText("Сбор проблем из Zabbix");
    await dlg.locator("input[name=name]").fill("Zabbix prod");
    await dlg.locator("input[name=url]").fill("https://zabbix.example.com");
    await dlg.locator("input[name=secret]").fill("zbx-token");
    await dlg.locator("[data-check]").click();
    const save = await app.called("connector_save");
    expect(save.args).toMatchObject({ connector: { kind: "zabbix", name: "Zabbix prod", url: "https://zabbix.example.com", auth: "token" }, secret: "zbx-token" });
    await app.called("alerts_test_source");
  });
});

test.describe("ssh", () => {
  test.beforeEach(async ({ app }) => { await app.view("ssh"); });
  const group = (page: Page, g: string) => page.locator(`details.ssh-group[data-g="${g}"]`);

  test("hosts are grouped; connect opens a terminal tab", async ({ app, page }) => {
    await expect(group(page, "prod").locator("tr")).toHaveCount(4);
    await expect(group(page, "stage").locator("tr")).toHaveCount(1);
    await expect(page.locator("details.ssh-group").last().locator("tr")).toHaveCount(2); // ~/.ssh/config
    await page.locator("tr[data-id=h3] [data-a=connect]").click();
    expect((await app.called("ssh_connect")).args).toEqual({ id: "h3", alias: null });
    await expect(page.locator('#sidebar button[data-view="terminal"]')).toHaveClass(/active/);
    await expect.poll(async () => (await app.calls("pty_spawn")).map((c) => (c.args as any).req.program)).toContain("ssh");
  });

  test("filter", async ({ page }) => {
    await page.locator(".ssh-filter").fill("app-");
    await expect(page.locator("tr[data-id]:visible, tr[data-alias]:visible")).toHaveCount(2);
  });

  test("drag a host into another group and into a new one", async ({ app, page }) => {
    const drag = async (from: string, to: import("@playwright/test").Locator) => {
      const a = (await page.locator(from).boundingBox())!;
      const b = (await to.boundingBox())!;
      await page.mouse.move(a.x + 20, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(a.x + 20, a.y + a.height / 2 + 40, { steps: 5 });
      await page.mouse.move(b.x + 30, b.y + b.height / 2, { steps: 10 });
      await page.mouse.up();
    };
    await drag("tr[data-id=h6]", group(page, "prod").locator("summary"));
    expect((await app.called("ssh_save")).args).toMatchObject({ host: { id: "h6", group: "prod" } });
    // selecting text inside a row must not start a drag
    expect(await page.evaluate(() => document.body.classList.contains("no-select"))).toBe(false);

    await page.mouse.move(0, 0);
    const a = (await page.locator("tr[data-id=h5]").boundingBox())!;
    await page.mouse.move(a.x + 20, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + 20, a.y + a.height + 30, { steps: 5 });
    const zone = page.locator(".ssh-new-group");
    await expect(zone).toBeVisible();
    const z = (await zone.boundingBox())!;
    await page.mouse.move(z.x + z.width / 2, z.y + z.height / 2, { steps: 10 });
    await page.mouse.up();
    const dlg = page.locator("dialog.ask");
    await dlg.locator("input").fill("db");
    await dlg.locator("button[value=ok]").click();
    await expect.poll(async () => (await app.calls("ssh_save")).at(-1)?.args).toMatchObject({ host: { id: "h5", group: "db" } });
  });

  test("new host dialog saves a profile", async ({ app, page }) => {
    await page.locator("section.view:not([hidden]) [data-a=add]").click();
    const dlg = page.locator("dialog.ssh-dialog");
    await dlg.locator("input[name=name]").fill("web-3");
    await dlg.locator("input[name=host]").fill("198.51.100.13");
    await dlg.locator("input[name=user]").fill("deploy");
    await dlg.locator("input[name=jump]").fill("bastion");
    await dlg.locator("button[value=save]").click();
    const save = await app.called("ssh_save");
    expect(save.args).toMatchObject({ host: { name: "web-3", host: "198.51.100.13", user: "deploy", jump: "bastion", port: 22, auth: "key" }, secret: null });
    await expect(dlg).toBeHidden();
  });
});

test.describe("keepass", () => {
  test("entries, search and copying", async ({ app, page }) => {
    await app.view("vault");
    const rows = page.locator(".kp-table tbody tr");
    await expect(rows).toHaveCount(7);
    // the search runs in the backend (titles, logins, URLs, groups, tags)
    await page.locator("section.view:not([hidden]) input").first().fill("grafana");
    await expect.poll(async () => (await app.calls("kp_entries")).at(-1)?.args).toEqual({ query: "grafana" });
    await rows.first().locator("[data-c=password]").click();
    await app.called("kp_copy");
  });
});
