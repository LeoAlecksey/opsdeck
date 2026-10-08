import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildPatterns, makeTr } from "../../src/i18n-core";

const en: Record<string, string> = JSON.parse(readFileSync(new URL("../../locales/en.json", import.meta.url), "utf8"));
const tr = makeTr(en, buildPatterns(en));

describe("translator", () => {
  it("exact strings keep surrounding whitespace", () => {
    expect(tr("Сохранить")).toBe("Save");
    expect(tr("  Сохранить ")).toBe("  Save ");
  });

  it("patterns fill placeholders, translating the captured parts too", () => {
    const d = { "Удалить «{}»?": "Delete “{}”?", "Модуль «{}» включён": "Module “{}” turned on", "Заметки": "Notes" };
    const t = makeTr(d, buildPatterns(d));
    expect(t("Удалить «prod.md»?")).toBe("Delete “prod.md”?");
    expect(t("Модуль «Заметки» включён")).toBe("Module “Notes” turned on");
  });

  it("a placeholder never eats part of a word (the «sловами» bug)", () => {
    const d = { "{} с{}": "{} with{}", "Ctrl+Shift+K локальный ИИ: команда по описанию словами": "Ctrl+Shift+K local AI: a command from words" };
    const t = makeTr(d, buildPatterns(d));
    expect(t("Ctrl+Shift+K локальный ИИ: команда по описанию словами")).toBe("Ctrl+Shift+K local AI: a command from words");
    expect(t("описанию словами")).toBe("описанию словами");
  });

  it("non-Russian text is left alone; multi-line text is translated line by line", () => {
    expect(tr("kubectl get pods")).toBe("kubectl get pods");
    expect(tr("Сохранить\nОтменить")).toBe("Save\nCancel");
  });
});

describe("en.json", () => {
  it("values are English and placeholders match", () => {
    for (const [k, v] of Object.entries(en)) {
      expect(v.trim(), k).not.toBe("");
      // file names stay as they are on disk (the default tasks note is «Задачи.md»)
      expect(/[А-Яа-яЁё]/.test(v.replace(/Задачи\.md/g, "")), `Cyrillic in the translation of «${k}»: ${v}`).toBe(false);
      expect((v.match(/\{\}/g) ?? []).length, `placeholders in «${k}»`).toBe((k.match(/\{\}/g) ?? []).length);
    }
  });
});
