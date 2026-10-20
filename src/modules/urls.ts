/**
 * Ссылки в выводе терминала: найти и понять, куда на самом деле идти.
 *
 * `python3 -m http.server` печатает «Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/)»,
 * vite — «http://localhost:5173/». Открывать 0.0.0.0 нельзя: это «слушаю на всех адресах», а не
 * адрес для подключения. И если команда выполнялась на хосте по ssh, её localhost — это localhost
 * того хоста, а не наш.
 */

/** Хвостовые знаки предложения в адрес не входят: «(http://host:8000/)» или «см. http://host.» */
const TRAIL = /[.,;:!?)\]}'"»]+$/;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`|]+/gi;

export type FoundUrl = { text: string; start: number };

/** Адреса в строке вывода с их позициями (позиция нужна, чтобы подчеркнуть ровно адрес). */
export function findUrls(line: string): FoundUrl[] {
  const out: FoundUrl[] = [];
  for (const m of line.matchAll(URL_RE)) {
    const text = m[0].replace(TRAIL, "");
    // «http://» без хоста ссылкой не считаем
    if (text.length > 8 && !/\/\/$/.test(text)) out.push({ text, start: m.index ?? 0 });
  }
  return out;
}

/** Адреса, которые означают «та машина, где это запущено», а не конкретный хост. */
const HERE = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::", "::1", "[::]", "[::1]"]);
/** Слушать на всех адресах можно, подключаться — нет. */
const ANY = new Set(["0.0.0.0", "::", "[::]"]);

/**
 * Где живёт адрес:
 *
 * * `here` — та машина, где выполнялась команда (localhost, 127.0.0.1, 0.0.0.0);
 * * `inside` — сеть той машины: короткое имя без точки (`adas-adcu-build-3`) или частный адрес
 *   (10/8, 172.16/12, 192.168/16, 100.64/10). Снаружи такое имя не резолвится и такой адрес не
 *   маршрутизируется — но `ssh -L` доводит до него через хост;
 * * `outside` — обычный адрес, который открывается как есть.
 */
export type Where = "here" | "inside" | "outside";

export type Target = {
  /** адрес, по которому действительно можно открыть (0.0.0.0 заменён на 127.0.0.1) */
  url: string;
  /** хост, к которому ведёт туннель: для `inside` — имя из адреса, для `here` — 127.0.0.1 */
  host: string;
  port: number;
  where: Where;
};

const PRIVATE_V4 = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

function whereIs(host: string): Where {
  if (HERE.has(host) || HERE.has(`[${host}]`) || /^127\./.test(host)) return "here";
  if (PRIVATE_V4.test(host)) return "inside";
  // короткое имя без точки живёт только в своей сети; «localhost.localdomain» уже с точкой
  if (!host.includes(".") && !host.includes(":")) return "inside";
  return "outside";
}

export function siteTarget(raw: string): Target | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  const where = whereIs(host);
  if (ANY.has(host) || ANY.has(`[${host}]`)) u.hostname = "127.0.0.1";
  return {
    url: u.toString(),
    host: where === "here" ? "127.0.0.1" : host,
    port: Number(u.port) || (u.protocol === "https:" ? 443 : 80),
    where,
  };
}

/** Тот же адрес, но через локальный порт туннеля к хосту. */
export function throughTunnel(raw: string, localPort: number): string {
  const u = new URL(raw);
  u.hostname = "127.0.0.1";
  u.port = String(localPort);
  return u.toString();
}
