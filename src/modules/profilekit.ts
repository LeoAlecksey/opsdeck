// Чистая логика окружений (profiles.ts): названия, цвета, метка — без DOM, чтобы проверялась тестами.

/** Основное окружение в командной строке и в списках. */
export const DEFAULT_ID = "default";

/** Цвета меток на выбор: прод красным, стенд жёлтым и так далее — как кому привычно. */
export const COLORS = ["#ef5f6b", "#f2b65c", "#7fdbca", "#82aaff", "#c792ea", "#9aa5bd"];

/** Своё название, иначе «Основное» у основного окружения и идентификатор у остальных. */
export function displayName(p: { id: string; name: string }, main = "Основное"): string {
  const name = p.name.trim();
  if (name) return name;
  return p.id === DEFAULT_ID ? main : p.id;
}

/** Цвет идёт в style разметки: только #rrggbb. */
export function normColor(c: string): string {
  return /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : "";
}

/** Две буквы для метки в узкой боковой колонке. */
export function initials(name: string): string {
  const words = name.trim().split(/[\s_.-]+/).filter(Boolean);
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] ?? "?").slice(0, 2).toUpperCase();
}
