/**
 * Гистограмма логов пода (#73): сколько строк было в каждом отрезке времени и сколько из них
 * ошибок. Время берётся из метки, которую ставит Kubernetes (`timestamps`), уровень — по слову
 * в строке. Чистые функции: разбор строки и раскладка по корзинам.
 */

export type Level = "error" | "warn" | "info";
export type Parsed = { time?: number; level: Level; text: string };

/** Метка времени Kubernetes в начале строки: 2026-10-13T18:04:10.123456789Z */
const TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s/;
const ERROR = /\b(error|err|fatal|panic|critical|crit|emerg|alert|exception|traceback|ошибка|ошибки)\b|\[(error|fatal)\]|"level":"(error|fatal)"/i;
const WARN = /\b(warn|warning|deprecated|предупреждение)\b|\[warn\]|"level":"warn(ing)?"/i;

/** Уровень строки по слову в ней: ошибка важнее предупреждения, остальное — обычная строка. */
export function levelOf(text: string): Level {
  return ERROR.test(text) ? "error" : WARN.test(text) ? "warn" : "info";
}

/** Строка от бэкенда → время, уровень и текст без метки времени. */
export function parseLogLine(raw: string): Parsed {
  const m = TS.exec(raw);
  const text = m ? raw.slice(m[0].length) : raw;
  const t = m ? Date.parse(m[1]) : NaN;
  return { time: Number.isNaN(t) ? undefined : t, level: levelOf(text), text };
}

export type Bucket = { from: number; to: number; error: number; warn: number; info: number };

/** Корзины от первой до последней строки со временем; строки без времени не считаются. */
export function buckets(lines: { time?: number; level?: Level }[], count = 60): Bucket[] {
  const timed = lines.filter((l) => l.time !== undefined).map((l) => ({ time: l.time!, level: l.level ?? ("info" as Level) }));
  if (!timed.length || count < 1) return [];
  const from = Math.min(...timed.map((l) => l.time));
  const to = Math.max(...timed.map((l) => l.time));
  // одна точка во времени (или всё в одну секунду) — одна корзина, иначе ширина нулевая
  const width = Math.max(1, Math.ceil((to - from + 1) / count));
  const out: Bucket[] = [];
  for (let i = 0; i < count && from + i * width <= to; i++) {
    out.push({ from: from + i * width, to: from + (i + 1) * width - 1, error: 0, warn: 0, info: 0 });
  }
  for (const l of timed) {
    const i = Math.min(out.length - 1, Math.floor((l.time - from) / width));
    out[i][l.level]++;
  }
  return out;
}

/** Подпись корзины для подсказки: «18:04:10–18:04:20 · 12, ошибок 3». */
export function bucketTitle(b: Bucket, timeFmt: (ms: number) => string): string {
  const n = b.error + b.warn + b.info;
  const extra = [b.error ? `ошибок ${b.error}` : "", b.warn ? `предупреждений ${b.warn}` : ""].filter(Boolean).join(", ");
  return `${timeFmt(b.from)}–${timeFmt(b.to + 1)} · ${n}${extra ? `, ${extra}` : ""}`;
}
