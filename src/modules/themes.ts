/**
 * Terminal colour themes: a few built-in schemes, plus schemes imported from Windows Terminal's
 * settings.json (its "schemes" list) or a single scheme in the same JSON format. The choice is kept
 * in this browser profile and applies to every terminal at once (event "term-theme").
 */
import type { ITheme } from "@xterm/xterm";

export type Theme = { name: string; colors: ITheme };

export const DEFAULT_THEME = "OpsDeck";

export const BUILTIN: Theme[] = [
  { name: "OpsDeck", colors: {
    background: "#0f1117", foreground: "#d6deeb", cursor: "#7fdbca", selectionBackground: "#2b3a55",
    black: "#1d2130", red: "#ef5f6b", green: "#98d982", yellow: "#e6c07b", blue: "#61afef",
    magenta: "#c678dd", cyan: "#56b6c2", white: "#d6deeb" } },
  // Windows Terminal's default scheme
  { name: "Campbell", colors: {
    background: "#0c0c0c", foreground: "#cccccc", cursor: "#ffffff", selectionBackground: "#3a3a3a",
    black: "#0c0c0c", red: "#c50f1f", green: "#13a10e", yellow: "#c19c00", blue: "#0037da", magenta: "#881798", cyan: "#3a96dd", white: "#cccccc",
    brightBlack: "#767676", brightRed: "#e74856", brightGreen: "#16c60c", brightYellow: "#f9f1a5", brightBlue: "#3b78ff", brightMagenta: "#b4009e", brightCyan: "#61d6d6", brightWhite: "#f2f2f2" } },
  { name: "One Half Dark", colors: {
    background: "#282c34", foreground: "#dcdfe4", cursor: "#a3b3cc", selectionBackground: "#474e5d",
    black: "#282c34", red: "#e06c75", green: "#98c379", yellow: "#e5c07b", blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#dcdfe4",
    brightBlack: "#5d677a", brightRed: "#e06c75", brightGreen: "#98c379", brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd", brightCyan: "#56b6c2", brightWhite: "#dcdfe4" } },
  { name: "Solarized Dark", colors: {
    background: "#002b36", foreground: "#839496", cursor: "#93a1a1", selectionBackground: "#073642",
    black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
    brightBlack: "#586e75", brightRed: "#cb4b16", brightGreen: "#586e75", brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3" } },
  { name: "Dracula", colors: {
    background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2", selectionBackground: "#44475a",
    black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c", blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
    brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94", brightYellow: "#ffffa5", brightBlue: "#d6acff", brightMagenta: "#ff92df", brightCyan: "#a4ffff", brightWhite: "#ffffff" } },
];

const KEY_CUR = "opsdeck.term.theme", KEY_MINE = "opsdeck.term.themes";
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// Windows Terminal names → xterm.js names
const MAP: Record<string, keyof ITheme> = {
  background: "background", foreground: "foreground", cursorColor: "cursor", selectionBackground: "selectionBackground",
  black: "black", red: "red", green: "green", yellow: "yellow", blue: "blue", purple: "magenta", magenta: "magenta", cyan: "cyan", white: "white",
  brightBlack: "brightBlack", brightRed: "brightRed", brightGreen: "brightGreen", brightYellow: "brightYellow", brightBlue: "brightBlue",
  brightPurple: "brightMagenta", brightMagenta: "brightMagenta", brightCyan: "brightCyan", brightWhite: "brightWhite",
  cursor: "cursor",
};

/** Schemes from Windows Terminal's settings.json ({"schemes": [...]}), a list, or one scheme. */
export function parseSchemes(text: string): Theme[] {
  // settings.json may have comments and trailing commas
  const clean = text.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/,(\s*[}\]])/g, "$1");
  let data: unknown;
  try { data = JSON.parse(clean); } catch { throw new Error("это не JSON — вставьте settings.json Windows Terminal или схему"); }
  const list = Array.isArray(data) ? data : Array.isArray((data as any)?.schemes) ? (data as any).schemes : [data];
  const out: Theme[] = [];
  for (const s of list) {
    if (!s || typeof s !== "object") continue;
    const colors: ITheme = {};
    for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
      const to = MAP[k];
      if (to && typeof v === "string" && HEX.test(v)) (colors as Record<string, string>)[to] = v;
    }
    if (!colors.background || !colors.foreground) continue;
    out.push({ name: String((s as any).name || "Импорт").slice(0, 60), colors });
  }
  if (!out.length) throw new Error("в JSON нет цветовых схем (нужны хотя бы background и foreground)");
  return out;
}

export function myThemes(): Theme[] {
  try { return JSON.parse(store.get(KEY_MINE) ?? "[]"); } catch { return []; }
}
export function allThemes(): Theme[] {
  const mine = myThemes();
  return [...BUILTIN.filter((b) => !mine.some((m) => m.name === b.name)), ...mine];
}
export function addThemes(list: Theme[]) {
  const names = new Set(list.map((t) => t.name));
  store.set(KEY_MINE, JSON.stringify([...myThemes().filter((t) => !names.has(t.name)), ...list]));
}
export function currentThemeName(): string {
  return store.get(KEY_CUR) ?? DEFAULT_THEME;
}
export function currentTheme(): ITheme {
  const name = currentThemeName();
  return (allThemes().find((t) => t.name === name) ?? BUILTIN[0]).colors;
}
export function setTheme(name: string) {
  store.set(KEY_CUR, name);
  window.dispatchEvent(new CustomEvent("term-theme", { detail: currentTheme() }));
}

/** Windows (WebView2): the "Windows" settings block and the WSL button are shown only there. */
export const isWindows = () => /Windows/.test(navigator.userAgent);
