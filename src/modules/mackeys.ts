import { bindingFor, parseBinding } from "./keybindings";

/**
 * Перемещение по строке в терминале привычными для macOS клавишами (#122). Оболочка о Cmd и Option
 * ничего не знает, поэтому они переводятся в то, что понимает readline (bash, zsh, PSReadLine в
 * режиме Emacs): Cmd+← / → — в начало и конец строки, Option+← / → — на слово, Cmd/Option+⌫ —
 * стереть до начала строки или слово.
 */
export type KeyLike = { key: string; code?: string; metaKey: boolean; altKey: boolean; ctrlKey: boolean; shiftKey: boolean };

/** `seq` уходит в оболочку; `like` — та же клавиша для серой подсказки (Cmd+→ принимает её
 *  целиком, как End, Option+→ — по слову, как Ctrl+→). */
export type MacNav = { seq: string; like?: { key: string; ctrlKey?: boolean } };

export function macNav(e: KeyLike): MacNav | null {
  const code = e.code ?? ({ ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", Backspace: "Backspace" } as Record<string, string>)[e.key]
    ?? (e.key.length === 1 ? (/^[A-Z]$/.test(e.key) ? `Key${e.key}` : /^\d$/.test(e.key) ? `Digit${e.key}` : e.key) : e.key);
  const matches = (id: string) => {
    const b = parseBinding(bindingFor(id));
    return !!b && code === b.code && e.metaKey === !!b.meta && e.altKey === !!b.alt && e.ctrlKey === !!b.ctrl && e.shiftKey === !!b.shift;
  };
  if (matches("terminal.line-start")) return { seq: "\x01" };
  if (matches("terminal.line-end")) return { seq: "\x05", like: { key: "End" } };
  if (matches("terminal.word-left")) return { seq: "\x1bb" };
  if (matches("terminal.word-right")) return { seq: "\x1bf", like: { key: "ArrowRight", ctrlKey: true } };
  if (matches("terminal.delete-line")) return { seq: "\x15" };
  if (matches("terminal.delete-word")) return { seq: "\x17" };
  return null;
}

export const isMac = () => navigator.platform.startsWith("Mac");
