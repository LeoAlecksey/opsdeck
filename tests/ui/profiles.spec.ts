import { test, expect } from "./fixtures";

// Окружения: каждое — отдельный экземпляр приложения (profile.rs); здесь — выбор, создание и метка.

test.describe("одно окружение", () => {
  test("всё как раньше: метки нет, окружения доступны из палитры и настроек", async ({ app, page }) => {
    await expect(page.locator("#sidebar .profile-badge")).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveClass(/has-profile/);
    await page.keyboard.press("Control+Shift+KeyP");
    await page.locator(".palette input").fill("Окружения");
    await expect(page.locator(".palette").getByText("Окружения: открыть другое, создать новое")).toBeVisible();
    await page.keyboard.press("Escape");

    await app.view("settings");
    await page.click("[data-profiles]");
    await expect(page.locator("dialog.profiles-dlg .profile-row")).toHaveCount(3);
    await expect(page.locator("dialog.profiles-dlg .profile-row.current .profile-name")).toHaveText("Основное");
  });
});

test.describe("несколько окружений", () => {
  test.use({ demo: { profile: { id: "stage", name: "Стенд", color: "#f2b65c", several: true, picker: false, notice: "" } } });

  test("метка окружения на окне и открытие другого", async ({ app, page }) => {
    const badge = page.locator("#sidebar .profile-badge");
    await expect(badge).toHaveText("СТ");
    await expect(page.locator("body")).toHaveClass(/has-profile/);

    await badge.click();
    const dlg = page.locator("dialog.profiles-dlg");
    await expect(dlg.locator(".profile-row.current .profile-name")).toHaveText("Стенд");
    // уже открытое в другом окне второй раз не запускается: кнопки нет
    const prod = dlg.locator(".profile-row", { hasText: "Прод" });
    await expect(prod).toContainText("открыто в другом окне");
    await expect(prod.locator("[data-open]")).toHaveCount(0);

    await dlg.locator(".profile-row", { hasText: "Основное" }).locator("[data-open]").click();
    expect((await app.called("profile_open")).args).toEqual({ id: "default" });
  });

  test("новое окружение создаётся и сразу открывается", async ({ app, page }) => {
    await page.click("#sidebar .profile-badge");
    const dlg = page.locator("dialog.profiles-dlg");
    await dlg.locator(".profile-new summary").click();
    await dlg.locator("[name=pname]").fill("QA");
    await dlg.locator("[name=pcopy][value='1']").check();
    await dlg.locator("[data-create]").click();
    expect((await app.called("profile_create")).args).toEqual({ name: "QA", color: "#ef5f6b", copy: true });
    expect((await app.called("profile_open")).args).toEqual({ id: "qa" });
  });

  test("что открывать при запуске", async ({ app, page }) => {
    await page.click("#sidebar .profile-badge");
    await page.locator("dialog.profiles-dlg select[name=start]").selectOption("stage");
    expect((await app.called("profile_start_set")).args).toEqual({ id: "stage" });
  });
});

test.describe("выбор окружения при запуске", () => {
  test.use({ demo: { profile: { id: "default", name: "", color: "", several: true, picker: true, notice: "окружение «Прод» уже открыто" } } });

  test("выбранное открывается, выбор можно запомнить", async ({ app, page }) => {
    await expect(page.locator("#sidebar button[data-view]")).toHaveCount(0);
    await expect(page.locator(".picker-notice")).toHaveText("окружение «Прод» уже открыто");
    await page.locator(".picker [name=remember]").check();
    await page.locator(".picker .profile-row", { hasText: "Стенд" }).locator("[data-open]").click();
    expect((await app.called("profile_start_set")).args).toEqual({ id: "stage" });
    expect((await app.called("profile_pick")).args).toEqual({ id: "stage" });
    // рабочее место в окне выбора не поднимается: ни одного окружения ещё не открыто
    expect(await app.calls("alerts_get")).toEqual([]);
  });
});
