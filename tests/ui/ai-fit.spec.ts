import { test, expect } from "./fixtures";

// Потянет ли компьютер модель: метки в списке, пояснение у выбранной и вопрос перед скачиванием.
const GiB = 1073741824;
const MODELS = (selected: string) => ({
  selected, custom_path: "", ram_total: 16 * GiB, gpu: false, gpu_supported: true, vulkan_found: true, metal: false, gpu_failed: false,
  models: [
    { id: "qwen2.5-coder-1.5b", title: "Лёгкая — Qwen2.5-Coder 1.5B", size: 1117320768, ram_gb: 4, installed: true, fit: { level: "good", why: "" } },
    { id: "qwen3.5-9b", title: "Мощная — Qwen3.5 9B", size: 5680522464, ram_gb: 16, installed: false, fit: { level: "good", why: "" } },
    { id: "qwen3.8-27b", title: "Сильная — Qwen3.8 27B", size: 16500000000, ram_gb: 24, installed: false,
      fit: { level: "no", why: "модели нужно не меньше 18 ГБ памяти, а в компьютере 16 ГБ" } },
    { id: "qwen3.6-35b-a3b", title: "Большая — Qwen3.6 35B-A3B (MoE)", size: 22134528992, ram_gb: 32, installed: false,
      fit: { level: "tight", why: "памяти впритык: 16 ГБ при рекомендованных 32 ГБ — остальные программы будут потеснены, ответы медленнее" } },
  ],
});
const STATUS = { supported: true, engine: true, model: false, running: false, installing: false, size: 0, download_size: 16500000000, dir: "/home/demo/.local/share/opsdeck/ai", model_title: "Сильная — Qwen3.8 27B" };

test.describe("will this PC run the model", () => {
  test.use({ demo: { overrides: { ai_models: MODELS("qwen3.8-27b"), ai_status: STATUS } } });

  test("the list marks what runs; the chosen one says why not; downloading it needs a yes", async ({ app, page }) => {
    await app.view("settings");
    const sel = page.locator(".ai-model");
    await expect(sel.locator("option[value='qwen3.5-9b']")).toContainText("★ для вашего ПК");
    await expect(sel.locator("option[value='qwen3.8-27b']")).toContainText("✕ не потянет");
    await expect(sel.locator("option[value='qwen3.6-35b-a3b']")).toContainText("⚠ памяти впритык");
    await expect(page.locator(".ai-fit")).toContainText("Этот компьютер модель не потянет: модели нужно не меньше 18 ГБ памяти, а в компьютере 16 ГБ");

    await page.locator("[data-ai=install]").click();
    await expect(page.locator("dialog.ask")).toContainText("Скорее всего, она не запустится");
    await page.locator("dialog.ask button[value=cancel]").click();
    expect(await app.calls("ai_install")).toHaveLength(0);

    await page.locator("[data-ai=install]").click();
    await page.locator("dialog.ask button.danger-solid").click();
    await app.called("ai_install");
  });

  test("a model that runs fine is downloaded without asking", async ({ app, page }) => {
    await app.override("ai_models", MODELS("qwen3.5-9b"));
    await app.view("settings");
    await expect(page.locator(".ai-fit")).toHaveCount(0);
    await page.locator("[data-ai=install]").click();
    await app.called("ai_install");
    await expect(page.locator("dialog.ask")).toHaveCount(0);
  });
});
