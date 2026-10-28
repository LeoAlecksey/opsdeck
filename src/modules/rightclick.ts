/**
 * What the right mouse button does in a terminal (#99): the usual menu, paste like PuTTY, or copy
 * the selection and otherwise paste, like Windows Terminal. Kept apart from pty.ts so the choice
 * is testable without xterm.
 */

export type RightClick = "menu" | "paste" | "copy-paste";

const KEY = "opsdeck.term.rightClick";
const MODES: RightClick[] = ["menu", "paste", "copy-paste"];

export function rightClickMode(): RightClick {
  try {
    const v = localStorage.getItem(KEY) as RightClick | null;
    return v && MODES.includes(v) ? v : "menu";
  } catch { return "menu"; }
}

/** Applies at once to every open terminal (they listen to `term-right-click`). */
export function setRightClickMode(mode: RightClick) {
  try { localStorage.setItem(KEY, mode); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("term-right-click", { detail: mode }));
}

/** One right click: leave the menu alone, copy the selection, or paste the clipboard. */
export function rightClickAction(mode: RightClick, hasSelection: boolean): "menu" | "copy" | "paste" {
  if (mode === "menu") return "menu";
  if (mode === "copy-paste" && hasSelection) return "copy";
  return "paste";
}
