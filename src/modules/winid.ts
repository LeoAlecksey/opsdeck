/**
 * Какое это окно и как назвать сессию в бэкенде.
 *
 * Сессии (pty, локальный чат ИИ, пинги) заводит фронтенд, а живут они в бэкенде: идентификатор —
 * ключ в его таблице и часть имени события (`pty-data-pty1`). У второго окна своя страница и свои
 * счётчики, поэтому без метки окна оба окна завели бы сессию с одним и тем же именем: события
 * разъехались бы по чужим терминалам, а запись в таблице перезаписала бы предыдущую.
 */

/** Метка окна Tauri: `main` у главного, `pop-<раздел>` у вынесенного. */
export function winLabel(): string {
  try {
    const meta = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__;
    return meta?.metadata?.currentWindow?.label || "main";
  } catch {
    return "main";
  }
}

/** Раздел, вынесенный в это окно, или «» в главном окне. */
export function popoutView(): string {
  const label = winLabel();
  return label.startsWith("pop-") ? label.slice(4) : "";
}

/** Метка в идентификаторах: в главном окне её нет, чтобы `pty1` остался `pty1`. */
const TAG = (() => {
  const label = winLabel();
  // в именах событий Tauri разрешены буквы, цифры, «-», «_», «/» и «:»
  return label === "main" ? "" : `-${label.replace(/[^A-Za-z0-9_-]/g, "")}-`;
})();

let n = 0;

/** Имя новой сессии: уникально и внутри окна, и между окнами. */
export const uid = (prefix: string) => `${prefix}${TAG}${++n}`;
