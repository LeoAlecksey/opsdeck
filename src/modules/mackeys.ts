/**
 * Перемещение по строке в терминале привычными для macOS клавишами (#122). Оболочка о Cmd и Option
 * ничего не знает, поэтому они переводятся в то, что понимает readline (bash, zsh, PSReadLine в
 * режиме Emacs): Cmd+← / → — в начало и конец строки, Option+← / → — на слово, Cmd/Option+⌫ —
 * стереть до начала строки или слово.
 */
export type KeyLike = { key: string; metaKey: boolean; altKey: boolean; ctrlKey: boolean; shiftKey: boolean };

/** `seq` уходит в оболочку; `like` — та же клавиша для серой подсказки (Cmd+→ принимает её
 *  целиком, как End, Option+→ — по слову, как Ctrl+→). */
export type MacNav = { seq: string; like?: { key: string; ctrlKey?: boolean } };

export function macNav(e: KeyLike): MacNav | null {
  // ровно один модификатор: Cmd+Shift+← и прочие сочетания остаются системе и xterm
  if (e.ctrlKey || e.shiftKey || e.metaKey === e.altKey) return null;
  if (e.metaKey) {
    if (e.key === "ArrowLeft") return { seq: "\x01" };
    if (e.key === "ArrowRight") return { seq: "\x05", like: { key: "End" } };
    if (e.key === "Backspace") return { seq: "\x15" };
    return null;
  }
  if (e.key === "ArrowLeft") return { seq: "\x1bb" };
  if (e.key === "ArrowRight") return { seq: "\x1bf", like: { key: "ArrowRight", ctrlKey: true } };
  if (e.key === "Backspace") return { seq: "\x17" };
  return null;
}

export const isMac = () => navigator.platform.startsWith("Mac");
