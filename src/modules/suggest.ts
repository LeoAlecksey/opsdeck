import { invoke } from "@tauri-apps/api/core";
import type { IDecoration, Terminal } from "@xterm/xterm";
import type { ShellBlocks } from "./blocks";

/**
 * fish-like inline suggestion: while typing at the prompt, the rest of a matching command
 * (this session, shell history, commands from notes) is shown in grey after the cursor.
 * → or End accepts it, Ctrl+→ accepts one word. Needs the shell integration (OSC 133 B).
 */
type Sugg = { command: string; source: string; note: string | null };

const KEY = "opsdeck.term.suggest";
export const suggestEnabled = () => { try { return localStorage.getItem(KEY) !== "0"; } catch { return true; } };
export function setSuggestEnabled(on: boolean) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("term-suggest", { detail: on }));
}

export class AutoSuggest {
  private deco: IDecoration | null = null;
  private rest = "";
  private typed = "";
  private timer = 0;
  private reqId = 0;
  private enabled = suggestEnabled();
  private onPref = (e: Event) => { this.enabled = (e as CustomEvent<boolean>).detail; if (!this.enabled) this.clear(); };

  constructor(private term: Terminal, private blocks: ShellBlocks, private send: (s: string) => void) {
    const sched = () => { clearTimeout(this.timer); this.timer = window.setTimeout(() => this.update(), 90); };
    term.onWriteParsed(sched);
    term.onCursorMove(sched);
    window.addEventListener("term-suggest", this.onPref);
  }

  dispose() {
    clearTimeout(this.timer);
    this.reqId++; // an answer still on its way must not draw on the closed terminal
    window.removeEventListener("term-suggest", this.onPref);
    this.clear();
  }

  /** Key handler hook: true = handled (accepted the suggestion). */
  key(e: KeyboardEvent): boolean {
    if (!this.rest || e.type !== "keydown" || e.altKey || e.metaKey || e.shiftKey) return false;
    if ((e.key === "ArrowRight" || e.key === "End") && !e.ctrlKey) {
      this.accept(this.rest);
      return true;
    }
    if (e.key === "ArrowRight" && e.ctrlKey) {
      // one word (with the spaces before it)
      const m = /^\s*\S+/.exec(this.rest);
      if (m) this.accept(m[0]);
      return true;
    }
    return false;
  }

  private accept(text: string) {
    this.clear();
    this.send(text);
  }

  private clear() {
    this.deco?.dispose();
    this.deco = null;
    this.rest = "";
  }

  /** What is typed at the prompt, and whether the cursor sits right after it. */
  private current(): { text: string; atEnd: boolean } | null {
    const b = this.blocks, buf = this.term.buffer.active;
    if (!b.atPrompt || !b.input || buf.type !== "normal") return null;
    let text = "";
    let endX = b.input.x, endY = b.input.marker.line;
    for (let y = b.input.marker.line; y < buf.length && y - b.input.marker.line < 20; y++) {
      const line = buf.getLine(y);
      if (!line || (y > b.input.marker.line && !line.isWrapped)) break;
      const from = y === b.input.marker.line ? b.input.x : 0;
      const s = line.translateToString(false, from);
      text += s;
      const trimmedLen = s.replace(/\s+$/, "").length;
      if (trimmedLen) { endX = from + trimmedLen; endY = y; }
    }
    text = text.replace(/\s+$/, "");
    const cy = buf.baseY + buf.cursorY;
    return { text, atEnd: cy === endY && buf.cursorX === endX };
  }

  private async update() {
    if (!this.enabled) return;
    const cur = this.current();
    if (!cur || !cur.atEnd || cur.text.length < 2 || cur.text.includes("\n")) { if (this.rest || this.deco) this.clear(); this.typed = cur?.text ?? ""; return; }
    if (cur.text === this.typed && this.deco) return;
    this.typed = cur.text;
    // this session first (newest), then history and notes from the backend
    const session = [...this.blocks.blocks].reverse().map((b) => b.command).find((c) => c && c.startsWith(cur.text) && c.length > cur.text.length);
    let best = session ?? null;
    if (!best) {
      const id = ++this.reqId;
      const list = await invoke<Sugg[]>("cmd_suggest", { prefix: cur.text, limit: 1 }).catch(() => [] as Sugg[]);
      if (id !== this.reqId) return; // typed further meanwhile
      best = list[0]?.command ?? null;
    }
    const again = this.current();
    if (!again || again.text !== cur.text || !again.atEnd) return;
    this.clear();
    if (!best) return;
    this.rest = best.slice(cur.text.length).split("\n")[0];
    this.draw();
  }

  private draw() {
    const buf = this.term.buffer.active;
    const marker = this.term.registerMarker(0);
    if (!marker) return;
    const room = this.term.cols - buf.cursorX;
    if (room <= 0) return;
    const shown = this.rest.length > room ? this.rest.slice(0, room - 1) + "…" : this.rest;
    const d = this.term.registerDecoration({ marker, x: buf.cursorX, width: Math.max(1, shown.length), layer: "top" });
    if (!d) { marker.dispose(); return; }
    d.onDispose(() => marker.dispose());
    d.onRender((el) => {
      el.textContent = shown;
      el.classList.add("term-ghost"); // keep xterm's own class: it positions the decoration
      el.style.fontFamily = String(this.term.options.fontFamily);
      el.style.fontSize = `${this.term.options.fontSize}px`;
      el.style.lineHeight = el.style.height;
    });
    this.deco = d;
  }
}
