/** Interface colours are independent of the terminal scheme. */
export type Appearance = "dark" | "light" | "system";
const KEY = "opsdeck.appearance";
const system = window.matchMedia("(prefers-color-scheme: light)");
function read(): Appearance {
  try { const value = localStorage.getItem(KEY); if (value === "light" || value === "system") return value; } catch { /* unavailable storage */ }
  return "dark";
}
let selected = read();
export const appearance = () => selected;
export const isLight = () => document.documentElement.dataset.appearance === "light";
function apply() {
  document.documentElement.dataset.appearance = selected === "system" ? (system.matches ? "light" : "dark") : selected;
  window.dispatchEvent(new Event("appearance-changed"));
}
export function setAppearance(value: Appearance) {
  selected = value;
  try { localStorage.setItem(KEY, value); } catch { /* use for this window */ }
  apply();
}
apply();
system.addEventListener("change", () => { if (selected === "system") apply(); });
window.addEventListener("storage", e => { if (e.key === KEY || e.key === null) { selected = read(); apply(); } });
