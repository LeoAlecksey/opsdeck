/** Keyboard shortcuts that users can change in Settings. Bindings use KeyboardEvent.code,
 * so letter shortcuts keep working when the keyboard layout changes. */
export type Keybinding = { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean; code: string };
export type Shortcut = { id: string; title: string; default: string; macOnly?: boolean };

export const SHORTCUTS: Shortcut[] = [
  { id: "code.prev-project", title: "IDE: предыдущий проект", default: "" },
  { id: "code.next-project", title: "IDE: следующий проект", default: "" },
  ...Array.from({ length: 9 }, (_, i) => ({ id: `view.${i + 1}`, title: `Перейти к модулю ${i + 1} (9 — последний)`, default: `Ctrl+Shift+Digit${i + 1}` })),
  { id: "k8s.prev-kind", title: "Kubernetes: предыдущий раздел", default: "Alt+ArrowUp" },
  { id: "k8s.next-kind", title: "Kubernetes: следующий раздел", default: "Alt+ArrowDown" },
  { id: "k8s.pod-shell", title: "Kubernetes: открыть shell в поде", default: "Ctrl+Alt+KeyS" },
  { id: "k8s.logs", title: "Kubernetes: открыть логи выбранного объекта", default: "Ctrl+Alt+KeyL" },
  { id: "k8s.port-forward", title: "Kubernetes: port-forward выбранного объекта", default: "Ctrl+Alt+KeyF" },
  { id: "terminal.line-start", title: "Терминал macOS: начало строки", default: "Meta+ArrowLeft", macOnly: true },
  { id: "terminal.line-end", title: "Терминал macOS: конец строки", default: "Meta+ArrowRight", macOnly: true },
  { id: "terminal.word-left", title: "Терминал macOS: на слово назад", default: "Alt+ArrowLeft", macOnly: true },
  { id: "terminal.word-right", title: "Терминал macOS: на слово вперёд", default: "Alt+ArrowRight", macOnly: true },
  { id: "terminal.delete-line", title: "Терминал macOS: удалить до начала строки", default: "Meta+Backspace", macOnly: true },
  { id: "terminal.delete-word", title: "Терминал macOS: удалить слово", default: "Alt+Backspace", macOnly: true },
];

const KEY = "opsdeck.keybindings";
const codeAliases: Record<string, string> = { " ": "Space", "+": "Equal", "-": "Minus" };
const fromCode = (code: string) => code.replace(/^Key/, "").replace(/^Digit/, "");
const fromLegacy = (value: string) => value.split("+").map((part) => {
  if (["Ctrl", "Alt", "Shift", "Meta"].includes(part)) return part;
  const code = codeAliases[part] ?? (/^[A-Z]$/.test(part) ? `Key${part}` : /^[0-9]$/.test(part) ? `Digit${part}` : part);
  return code;
}).join("+");

export function parseBinding(value: string): Keybinding | null {
  const parts = fromLegacy(value).split("+");
  const code = parts.pop();
  if (!code || ["Ctrl", "Alt", "Shift", "Meta"].includes(code)) return null;
  const mods = new Set(parts);
  return { ctrl: mods.has("Ctrl"), alt: mods.has("Alt"), shift: mods.has("Shift"), meta: mods.has("Meta"), code };
}

export function bindingString(e: KeyboardEvent): string | null {
  if (!e.code || ["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"].includes(e.code)) return null;
  const parts = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"].filter(Boolean) as string[];
  if (!parts.length) return null;
  return [...parts, e.code].join("+");
}

export function bindingLabel(value: string): string {
  const b = parseBinding(value);
  if (!b) return "Не назначено";
  const mods = [b.ctrl && "Ctrl", b.alt && "Alt", b.shift && "Shift", b.meta && "Cmd"].filter(Boolean) as string[];
  const names: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Backspace: "⌫", Enter: "Enter", Space: "Пробел", Escape: "Esc", Tab: "Tab", Equal: "=", Minus: "-" };
  return [...mods, names[b.code] ?? fromCode(b.code)].join("+");
}

export function bindings(): Record<string, string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === "string"));
  } catch { return {}; }
}

export function bindingFor(id: string): string {
  const def = SHORTCUTS.find((s) => s.id === id);
  if (!def) return "";
  return bindings()[id] ?? def.default;
}

export function setBinding(id: string, value: string | null): void {
  const saved = bindings();
  const def = SHORTCUTS.find((s) => s.id === id);
  if (!def) return;
  if (value === def.default) delete saved[id];
  else saved[id] = value ?? "";
  try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* unavailable storage */ }
  window.dispatchEvent(new Event("keybindings-changed"));
}

export function resetBindings(): void {
  try { localStorage.removeItem(KEY); } catch { /* unavailable storage */ }
  window.dispatchEvent(new Event("keybindings-changed"));
}

export function matchesBinding(e: KeyboardEvent, value: string): boolean {
  const b = parseBinding(value);
  return !!b && e.code === b.code && e.ctrlKey === !!b.ctrl && e.altKey === !!b.alt && e.shiftKey === !!b.shift && e.metaKey === !!b.meta;
}

export function matchShortcut(e: KeyboardEvent, id: string): boolean {
  const def = SHORTCUTS.find((s) => s.id === id);
  return !!def && matchesBinding(e, bindingFor(id));
}

export function changedBinding(value: string, ignoreId: string): string | null {
  if (value === "Ctrl+Shift+KeyP") return "Палитра команд";
  for (const def of SHORTCUTS) {
    if (def.id !== ignoreId && bindingFor(def.id) === value) return def.title;
  }
  return null;
}
