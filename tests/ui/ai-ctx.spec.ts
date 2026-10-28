import { test, expect } from "./fixtures";

// Размер контекста встроенного движка выбирается в настройках: 4096…65536, по умолчанию 16384.
test("local AI: the context size is chosen from the list, 16K by default", async ({ app, page }) => {
  await app.view("settings");
  const sel = page.locator(".ai-ctx");
  await expect(sel).toHaveValue("16384");
  await expect(sel.locator("option")).toHaveCount(5);
  await expect(sel.locator("option").first()).toHaveAttribute("value", "4096");
  await expect(sel.locator("option").last()).toHaveAttribute("value", "65536");
  await expect(sel.locator("option[value='16384']")).toContainText("по умолчанию");
  await sel.selectOption("32768");
  expect((await app.called("ai_set_ctx")).args).toEqual({ ctx: 32768 });
});
