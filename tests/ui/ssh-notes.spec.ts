import { test, expect } from "./fixtures";

// Контекст для ИИ у SSH-хостов: что на сервере крутится и что важно — ИИ получает его сам.
test.describe("SSH host context for the AI", () => {
  test.beforeEach(async ({ app }) => { await app.view("ssh"); });

  test("an own host: the context is written in the host dialog and saved by its key", async ({ app, page }) => {
    const row = page.locator("tr[data-id=h3]");
    await row.hover();
    await row.locator("[data-a=edit]").click();
    const dlg = page.locator("dialog.ssh-dialog");
    await expect(dlg.locator("[name=ai_note]")).toHaveValue("");
    await dlg.locator("[name=ai_note]").fill("api магазина в docker compose, /srv/shop\nбез согласования не перезапускать");
    await dlg.locator("button[value=save]").click();
    await app.called("ssh_save");
    expect((await app.called("ssh_note_set")).args).toEqual({ key: "id:h3", text: "api магазина в docker compose, /srv/shop\nбез согласования не перезапускать" });
  });

  test("an unchanged context is not written again", async ({ app, page }) => {
    const row = page.locator("tr[data-id=h3]");
    await row.hover();
    await row.locator("[data-a=edit]").click();
    await page.locator("dialog.ssh-dialog button[value=save]").click();
    await app.called("ssh_save");
    expect(await app.calls("ssh_note_set")).toHaveLength(0);
  });

  test("a ~/.ssh/config host: its own button, keyed by the alias", async ({ app, page }) => {
    const row = page.locator("tr[data-alias=monitoring]");
    await row.hover();
    await row.locator("[data-a=note-cfg]").click();
    const dlg = page.locator("dialog.ssh-note-dialog");
    await expect(dlg).toContainText("monitoring");
    await dlg.locator("textarea").fill("Prometheus + Grafana, данные в /var/lib/prometheus");
    await dlg.locator("button.primary").click();
    expect((await app.called("ssh_note_set")).args).toEqual({ key: "alias:monitoring", text: "Prometheus + Grafana, данные в /var/lib/prometheus" });
    await expect(page.locator(".toast").last()).toContainText("Контекст сохранён");
  });

  test("a host with context is marked; hovering shows the text; the dialog shows it for editing", async ({ app, page }) => {
    const list = await page.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke("ssh_list"));
    await app.override("ssh_list", { ...list, notes: { "id:h3": "api магазина, /srv/shop", "alias:gitlab": "GitLab CE, бэкапы в S3" } });
    await app.view("terminal");
    await app.view("ssh");
    await page.locator(".ssh-filter").fill("a");
    await page.locator(".ssh-filter").fill("");
    await expect(page.locator("tr[data-id=h3] .ssh-note")).toHaveAttribute("title", "Контекст для ИИ: api магазина, /srv/shop");
    await expect(page.locator("tr[data-alias=gitlab] .ssh-note")).toHaveCount(1);
    await expect(page.locator("tr[data-id=h4] .ssh-note")).toHaveCount(0);
    const row = page.locator("tr[data-id=h3]");
    await row.hover();
    await row.locator("[data-a=edit]").click();
    await expect(page.locator("dialog.ssh-dialog [name=ai_note]")).toHaveValue("api магазина, /srv/shop");
  });
});
