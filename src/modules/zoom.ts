/**
 * Масштаб текста в IDE и Заметках — как размер шрифта в терминале: Ctrl+= / Ctrl+− / Ctrl+0
 * (на macOS и с Cmd) и Ctrl+колесо. Хранится отдельно для каждого раздела. Здесь только чистая
 * логика; подключение к разделу — attachZoom в ui.ts.
 */

export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 2;

/** +1 крупнее, −1 мельче, 0 — как было по умолчанию; null — не эта клавиша. */
export function zoomKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): number | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  return ({ "=": 1, "+": 1, "-": -1, "_": -1, "0": 0, ")": 0 } as Record<string, number>)[e.key] ?? null;
}

/** Шаг по 10%, в пределах 70–200%; 0 — обратно к 100%. */
export function nextZoom(cur: number, step: number): number {
  if (step === 0) return 1;
  const v = Math.round((cur + step / 10) * 10) / 10;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
}

/** Сохранённое значение → масштаб; мусор и пустота — 100%. */
export function parseZoom(saved: string | null): number {
  const v = Number(saved);
  return v ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v)) : 1;
}
