import { currentTheme } from "./themes";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ShellBlocks } from "./blocks";
import { hlPrefs, InputHighlighter, OutputHighlighter, type HlPrefs } from "./highlight";
import { AutoSuggest } from "./suggest";
import type { Launched } from "./shellkind";

let seq = 0;

export type SpawnOpts = { program?: string; args?: string[]; cwd?: string; env?: Record<string, string> };


function b64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- font preferences (shared by all local/SSH and AI terminals) ----------

const FONT_KEY = "opsdeck.term.fontSize";
const FONT_FAMILY_KEY = "opsdeck.term.fontFamily";
const FONT_FALLBACK = "'JetBrains Mono', 'Fira Code', monospace";
const cleanFontFamily = (name: string) => name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 128);

/** Empty means the original default font stack; custom names are a single CSS family. */
export function termFontFamily(): string {
  try { return cleanFontFamily(localStorage.getItem(FONT_FAMILY_KEY) ?? ""); } catch { return ""; }
}

function termFontStack(name = termFontFamily()): string {
  return name ? `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}", ${FONT_FALLBACK}` : FONT_FALLBACK;
}

/** Offered in ⚙ → Терминал; any other installed font can be typed in. */
export const TERM_FONTS = [
  "MesloLGS NF", "JetBrainsMono Nerd Font Mono", "FiraCode Nerd Font Mono", "Hack Nerd Font Mono",
  "JetBrains Mono", "Fira Code", "Cascadia Code", "Source Code Pro", "Ubuntu Mono",
  "DejaVu Sans Mono", "Liberation Mono", "Noto Sans Mono", "Menlo", "SF Mono", "Monaco", "Consolas", "Courier New",
];

/**
 * Whether a font is installed: text in it must differ in width from at least one generic family
 * (the same font can be the system's monospace fallback, but it cannot match all three).
 */
export function fontInstalled(name: string): boolean {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return true;
  const sample = "mmmmmmmmmmlli1WW@#ЖЩ";
  const width = (family: string) => { ctx.font = `72px ${family}`; return ctx.measureText(sample).width; };
  const quoted = `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return ["monospace", "serif", "sans-serif"].some((base) => width(`${quoted}, ${base}`) !== width(base));
}

export function setTermFontFamily(name: string) {
  const value = cleanFontFamily(name);
  try { localStorage.setItem(FONT_FAMILY_KEY, value); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("term-font-family", { detail: value }));
}
export const TERM_FONT_DEFAULT = 13;
const clampFont = (n: number) => Math.min(32, Math.max(8, Math.round(n)));

export function termFontSize(): number {
  try {
    const n = Number(localStorage.getItem(FONT_KEY));
    return n ? clampFont(n) : TERM_FONT_DEFAULT;
  } catch {
    return TERM_FONT_DEFAULT;
  }
}

/** Set an absolute size, or step it with "+1"/"-1"-style deltas via termFontStep. */
export function setTermFontSize(n: number) {
  const v = clampFont(n);
  try { localStorage.setItem(FONT_KEY, String(v)); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("term-font", { detail: v }));
}

export const termFontStep = (d: number) => setTermFontSize(d === 0 ? TERM_FONT_DEFAULT : termFontSize() + d);

/** xterm.js bound to a backend PTY running `program` (defaults to $SHELL). */
export class PtyTerminal {
  readonly id = `pty${++seq}`;
  readonly term = new Terminal({
    fontFamily: termFontStack(), fontSize: termFontSize(), cursorBlink: true,
    scrollback: 20000, theme: currentTheme(), allowProposedApi: true, overviewRulerWidth: 8,
  });
  /** Command blocks (only populated when the shell integration is active). */
  readonly blocks = new ShellBlocks(this.term);
  private fit = new FitAddon();
  private outHl = new OutputHighlighter(this.term, this.blocks);
  private inHl = new InputHighlighter(this.term, this.blocks);
  private sugg = new AutoSuggest(this.term, this.blocks, (s) => this.send(s));
  private hl: HlPrefs = hlPrefs();
  private onHl = (e: Event) => {
    this.hl = (e as CustomEvent<HlPrefs>).detail;
    this.inHl.setEnabled(this.hl.input);
  };
  private onFont = (e: Event) => {
    this.term.options.fontSize = (e as CustomEvent<number>).detail;
    this.resize();
  };
  private onTheme = (e: Event) => {
    this.term.options.theme = (e as CustomEvent).detail;
    this.host.style.background = this.term.options.theme?.background ?? "";
  };
  private onFontFamily = (e: Event) => {
    this.term.options.fontFamily = termFontStack((e as CustomEvent<string>).detail);
    this.resize();
  };
  private unlisten: UnlistenFn[] = [];
  private ro: ResizeObserver;
  onExit?: () => void;
  /** What the backend actually started (a plain tab gets the shell chosen in Settings). */
  launched: Launched | null = null;

  constructor(readonly host: HTMLElement, readonly spawn: SpawnOpts = {}) {
    const opts = spawn;
    this.term.loadAddon(this.fit);
    this.term.open(host);
    this.inHl.setEnabled(this.hl.input);
    window.addEventListener("term-highlight", this.onHl);
    window.addEventListener("term-font", this.onFont);
    window.addEventListener("term-font-family", this.onFontFamily);
    window.addEventListener("term-theme", this.onTheme);
    host.style.background = this.term.options.theme?.background ?? "";
    // Ctrl+wheel: font size
    host.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      termFontStep(e.deltaY < 0 ? 1 : -1);
    }, { passive: false, capture: true });
    this.term.onData((data) => invoke("pty_write", { id: this.id, data }));
    this.term.attachCustomKeyEventHandler((e) => {
      // → / End accept the grey suggestion
      if (this.sugg.key(e)) { e.preventDefault(); return false; }
      if (e.type !== "keydown" || !e.ctrlKey) return true;
      // Ctrl+Shift+K: ask the local AI for a command (by key position, so any layout works)
      if (e.code === "KeyK" && e.shiftKey && !e.altKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("ai-ask", { detail: this }));
        return false;
      }
      // Ctrl+= / Ctrl++ bigger, Ctrl+- smaller, Ctrl+0 default (with or without Shift)
      const zoom = ({ "=": 1, "+": 1, "-": -1, "_": -1, "0": 0, ")": 0 } as Record<string, number>)[e.key];
      if (zoom !== undefined && !e.altKey) {
        e.preventDefault();
        termFontStep(zoom);
        return false;
      }
      if (!e.shiftKey) return true;
      // letter by key position: Ctrl+Shift+C/V work on the Russian layout too
      const k = e.code.startsWith("Key") ? e.code.slice(3) : e.key.toUpperCase();
      // preventDefault: otherwise WebKit also runs its own copy/paste for the same keys
      // and the text lands in the terminal twice
      if (k === "C" && this.term.hasSelection()) {
        e.preventDefault();
        invoke("clip_write", { text: this.term.getSelection() });
        return false;
      }
      if (k === "V") {
        e.preventDefault();
        invoke<string>("clip_read").then((t) => t && this.term.paste(t));
        return false;
      }
      return true;
    });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.start(opts);
  }

  private async start(opts: SpawnOpts) {
    this.unlisten.push(await listen<string>(`pty-data-${this.id}`, (e) => this.term.write(this.outHl.feed(b64(e.payload), this.hl.output))));
    this.unlisten.push(await listen(`pty-exit-${this.id}`, () => {
      this.term.write(`\r\n\x1b[2m[${t("процесс завершён")}]\x1b[0m\r\n`);
      this.onExit?.();
    }));
    this.safeFit();
    try {
      this.launched = await invoke<Launched>("pty_spawn", { req: { id: this.id, ...opts, cols: this.term.cols, rows: this.term.rows } });
    } catch (e) {
      this.term.write(`\x1b[31m${t("Не удалось запустить")} ${opts.program ?? "shell"}: ${t(String(e))}\x1b[0m\r\n`);
    }
  }

  private safeFit() {
    if (this.host.offsetParent !== null && this.host.clientWidth > 0) this.fit.fit();
  }

  resize() {
    const { cols, rows } = this.term;
    this.safeFit();
    if (cols !== this.term.cols || rows !== this.term.rows)
      invoke("pty_resize", { id: this.id, cols: this.term.cols, rows: this.term.rows }).catch(() => {});
  }

  send(text: string) {
    return invoke("pty_write", { id: this.id, data: text });
  }

  dispose() {
    this.ro.disconnect();
    window.removeEventListener("term-highlight", this.onHl);
    window.removeEventListener("term-font", this.onFont);
    window.removeEventListener("term-font-family", this.onFontFamily);
    window.removeEventListener("term-theme", this.onTheme);
    this.sugg.dispose();
    this.unlisten.forEach((u) => u());
    invoke("pty_kill", { id: this.id });
    this.term.dispose();
  }
}
