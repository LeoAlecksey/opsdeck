/**
 * Сочетания клавиш на русской (и любой не латинской) раскладке. С Ctrl или Alt браузер отдаёт
 * в `key` букву раскладки («с» вместо «c»), а xterm и CodeMirror ищут привязки по ней — поэтому
 * Ctrl+C, Ctrl+R, Alt+B в терминале и Ctrl+] в редакторе не делали ничего. Физическая клавиша
 * (`code`) от раскладки не зависит: по ней и восстанавливаем латинский символ.
 */
export type KeyLike = { key: string; code: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean };

const PUNCT: Record<string, [string, string]> = {
  BracketLeft: ["[", "{"], BracketRight: ["]", "}"], Backslash: ["\\", "|"], Semicolon: [";", ":"],
  Quote: ["'", "\""], Comma: [",", "<"], Period: [".", ">"], Slash: ["/", "?"], Backquote: ["`", "~"],
  Minus: ["-", "_"], Equal: ["=", "+"],
};

/** Латинский символ клавиши — только когда раскладка не латинская и зажат Ctrl, Alt или Cmd:
 *  на латинице (в том числе Dvorak) и при обычном наборе текста ничего не меняется. */
export function latinKey(e: KeyLike): string | null {
  if (!(e.ctrlKey || e.altKey || e.metaKey)) return null;
  // одиночный символ в ASCII — раскладка латинская, всё работает и так
  if (e.key.length !== 1 || e.key.charCodeAt(0) < 128) return null;
  const letter = /^Key([A-Z])$/.exec(e.code)?.[1];
  if (letter) return e.shiftKey ? letter : letter.toLowerCase();
  const p = PUNCT[e.code];
  return p ? p[e.shiftKey ? 1 : 0] : null;
}

/** Ctrl+символ → управляющий байт, как его шлёт терминал на латинице. */
function ctrlByte(ch: string): string | null {
  const c = ch.toUpperCase();
  if (c >= "A" && c <= "Z") return String.fromCharCode(c.charCodeAt(0) - 64);
  return ({ "[": "\x1b", "\\": "\x1c", "]": "\x1d", "/": "\x1f", "-": "\x1f", "`": "\x00" } as Record<string, string>)[ch] ?? null;
}

/**
 * Что отправить в терминал за Ctrl/Alt+клавишу на нелатинской раскладке: Ctrl+С → ^C,
 * Alt+И → ESC b (слово назад в readline), Ctrl+Alt — ESC и управляющий байт. Ctrl+Shift и Cmd —
 * это команды самого OpsDeck и системы, они сюда не попадают.
 */
export function termSeq(e: KeyLike): string | null {
  if (e.metaKey || (e.ctrlKey && e.shiftKey)) return null;
  const ch = latinKey(e);
  if (!ch) return null;
  if (e.ctrlKey) {
    const b = ctrlByte(ch);
    return b === null ? null : (e.altKey ? "\x1b" : "") + b;
  }
  return "\x1b" + ch;
}
