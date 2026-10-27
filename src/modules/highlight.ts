import { invoke } from "@tauri-apps/api/core";
import type { IDecoration, Terminal } from "@xterm/xterm";
import type { ShellBlocks } from "./blocks";

// ---------- settings (per viewer, applied immediately) ----------

export type HlPrefs = { input: boolean; output: boolean };
const KEY = "opsdeck.term.highlight";

export function hlPrefs(): HlPrefs {
  try {
    return { input: true, output: true, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { input: true, output: true };
  }
}

export function setHlPrefs(p: Partial<HlPrefs>) {
  const next = { ...hlPrefs(), ...p };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("term-highlight", { detail: next }));
}

// ---------- output: colour plain text as it streams in ----------

const SGR: Record<string, string> = {
  err: "\x1b[1;31m", warn: "\x1b[33m", info: "\x1b[36m", dbg: "\x1b[2m",
  ok: "\x1b[32m", pend: "\x1b[33m", bad: "\x1b[31m",
  ip: "\x1b[35m", url: "\x1b[4;34m", time: "\x1b[2m",
};
const RESET = "\x1b[22;24;39m";

// one pass, first alternative wins; word boundaries keep "errors.go" or "terror" untouched
const OUT_RE = new RegExp([
  String.raw`(?<url>\bhttps?://[^\s"'<>()\[\]]+[^\s"'<>()\[\].,;:!?])`,
  String.raw`(?<time>\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)`,
  String.raw`(?<ip>\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?:/\d{1,2})?(?::\d{1,5})?\b)`,
  String.raw`(?<err>\b(?:ERROR|ERR|FATAL|CRIT(?:ICAL)?|PANIC|EMERG|ALERT|FAIL(?:ED|URE)?|[Ee]rror|[Ff]ailed|[Ff]atal|[Pp]anic|[Ee]xception|Traceback|[Dd]enied|[Rr]efused|[Tt]imed out)\b)`,
  String.raw`(?<warn>\b(?:WARN(?:ING)?|[Ww]arning|DEPRECATED|[Dd]eprecated)\b)`,
  String.raw`(?<info>\b(?:INFO|NOTICE)\b)`,
  String.raw`(?<dbg>\b(?:DEBUG|TRACE)\b)`,
  // Kubernetes / ArgoCD / systemd states
  String.raw`(?<bad>\b(?:CrashLoopBackOff|ImagePullBackOff|ErrImagePull|OOMKilled|Evicted|CreateContainerConfigError|InvalidImageName|NotReady|Degraded|OutOfSync|Unhealthy|Missing)\b)`,
  String.raw`(?<pend>\b(?:Pending|ContainerCreating|PodInitializing|Terminating|Progressing|Init:\d+/\d+|Unknown|activating|deactivating)\b)`,
  String.raw`(?<ok>\b(?:Running|Completed|Succeeded|Healthy|Synced|Bound|Ready|active \(running\)|ok|OK|PASS(?:ED)?)\b)`,
].join("|"), "g");

/**
 * Inserts colours into plain command output. Escape sequences are passed through untouched
 * (state is kept across chunks); text that a program already colours, the prompt and
 * full-screen programs (alternate screen: vim, htop, less, k9s) are left as they are.
 */
export class OutputHighlighter {
  private decoder = new TextDecoder();
  private esc = ""; // unfinished escape sequence carried over from the previous chunk
  private styled = false;
  private alt = false;
  /** Between OSC 133 A and C: the shell draws/edits its prompt (tracked here, in stream order). */
  private prompt = false;

  constructor(term: Terminal, blocks: ShellBlocks) {
    this.alt = term.buffer.active.type === "alternate";
    this.prompt = blocks.inPrompt;
  }

  /** Bytes from the PTY → string for term.write (UTF-8 decoded as a stream). */
  feed(bytes: Uint8Array, highlight: boolean): string {
    const text = this.decoder.decode(bytes, { stream: true });
    if (!highlight) {
      this.track(text);
      return text;
    }
    return this.colour(text);
  }

  /** Keep the escape/SGR/alt-screen state in sync even while highlighting is off. */
  private track(text: string) {
    this.walk(text, () => {});
  }

  private colour(text: string): string {
    let out = "";
    this.walk(text, (plain) => {
      out += this.alt || this.styled || this.prompt ? plain : plain.replace(OUT_RE, (m, ...args) => {
        const groups = args[args.length - 1] as Record<string, string | undefined>;
        const kind = Object.keys(groups).find((k) => groups[k] !== undefined);
        return kind ? SGR[kind] + m + RESET : m;
      });
    }, (seq) => { out += seq; });
    return out;
  }

  /** Splits text into plain runs and escape sequences, updating state on the sequences. */
  private walk(text: string, onPlain: (s: string) => void, onSeq: (s: string) => void = () => {}) {
    const s = this.esc + text;
    this.esc = "";
    let i = 0;
    while (i < s.length) {
      const e = s.indexOf("\x1b", i);
      if (e < 0) { onPlain(s.slice(i)); break; }
      if (e > i) onPlain(s.slice(i, e));
      const end = seqEnd(s, e);
      if (end < 0) { this.esc = s.slice(e); if (this.esc.length > 4096) { onSeq(this.esc); this.esc = ""; } break; }
      const seq = s.slice(e, end);
      this.state(seq);
      onSeq(seq);
      i = end;
    }
  }

  private state(seq: string) {
    if (seq.startsWith("\x1b]133;")) {
      if (seq[6] === "A") this.prompt = true;
      else if (seq[6] === "C") this.prompt = false;
      return;
    }
    if (seq[1] !== "[") return;
    const final = seq[seq.length - 1];
    const params = seq.slice(2, -1);
    if (final === "m") {
      const ps = params.split(";");
      if (ps.every((p) => p === "" || p === "0")) this.styled = false;
      else if (!ps.every((p) => ["39", "49", "22", "23", "24", "25", "27", "29"].includes(p))) this.styled = true;
    } else if ((final === "h" || final === "l") && /^\?(1049|1047|47)$/.test(params)) {
      this.alt = final === "h";
    }
  }
}

/** Index just past the escape sequence starting at `i`, or -1 if it's cut off. */
function seqEnd(s: string, i: number): number {
  const t = s[i + 1];
  if (t === undefined) return -1;
  if (t === "[") { // CSI: params/intermediates then a final byte 0x40–0x7e
    for (let j = i + 2; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) return j + 1;
    }
    return -1;
  }
  if (t === "]" || t === "P" || t === "_" || t === "^") { // OSC / DCS / APC / PM: until BEL or ST
    for (let j = i + 2; j < s.length; j++) {
      if (s[j] === "\x07") return j + 1;
      if (s[j] === "\x1b") return s[j + 1] === undefined ? -1 : j + 2;
    }
    return -1;
  }
  if (t === "(" || t === ")" || t === "*" || t === "+" || t === "#" || t === "%") return i + 3 <= s.length ? i + 3 : -1;
  return i + 2;
}

// ---------- input: colour the command line while it's typed (fish-like) ----------

let commands: Set<string> | null = null;
let loading: Promise<void> | null = null;
let loadedAt = 0;

function loadCommands(force = false): Promise<void> {
  if (loading) return loading;
  if (commands && !force) return Promise.resolve();
  if (force && Date.now() - loadedAt < 15000) return Promise.resolve();
  loading = invoke<string[]>("shell_commands")
    .then((xs) => { commands = new Set(xs); loadedAt = Date.now(); })
    .catch(() => { commands ??= new Set(); })
    .finally(() => { loading = null; });
  return loading;
}

const C = {
  cmd: "#98d982", bad: "#ef5f6b", flag: "#56b6c2", str: "#e6c07b", vari: "#c678dd",
  op: "#61afef", comment: "#6b7385", path: "#d6deeb",
};

type Tok = { start: number; end: number; color: string };

/** Very small shell lexer: enough to colour commands, flags, strings, variables and operators. */
function lex(line: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let expectCmd = true;
  while (i < line.length) {
    const c = line[i];
    if (c === " " || c === "\t") { i++; continue; }
    if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) { toks.push({ start: i, end: line.length, color: C.comment }); break; }
    const op = /^(\|\||&&|;;|\||;|&|\(|\)|[0-9]?>>?|<<<?|<|>&|&>)/.exec(line.slice(i));
    if (op) {
      toks.push({ start: i, end: i + op[0].length, color: C.op });
      if (/^(\|\||&&|\||;|&|\()$/.test(op[0])) expectCmd = true;
      i += op[0].length;
      continue;
    }
    // a word: runs until unquoted whitespace/operator
    const start = i;
    const parts: Tok[] = [];
    while (i < line.length && !/[\s|;&<>()]/.test(line[i])) {
      if (line[i] === "'" || line[i] === '"') {
        const q = line[i];
        let j = i + 1;
        while (j < line.length && line[j] !== q) j += line[j] === "\\" && q === '"' ? 2 : 1;
        parts.push({ start: i, end: Math.min(j + 1, line.length), color: C.str });
        i = Math.min(j + 1, line.length);
      } else if (line[i] === "$") {
        const m = /^\$(\{[^}]*\}?|\(|[A-Za-z_][A-Za-z0-9_]*|[0-9#?@*$!-])/.exec(line.slice(i));
        const len = m ? m[0].length : 1;
        parts.push({ start: i, end: i + len, color: C.vari });
        i += len;
      } else if (line[i] === "\\") i += 2;
      else i++;
    }
    i = Math.min(i, line.length);
    const word = line.slice(start, i);
    if (expectCmd && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      // VAR=value before the command
      toks.push({ start, end: start + word.indexOf("="), color: C.vari }, ...parts);
      continue;
    }
    if (expectCmd) {
      expectCmd = ["sudo", "time", "env", "nohup", "exec", "command", "builtin", "xargs", "watch", "!"].includes(word);
      if (parts.length || word.includes("/") || word.startsWith("~")) toks.push({ start, end: i, color: C.path }, ...parts);
      else if (!commands?.size) toks.push({ start, end: i, color: C.cmd }); // list not known (yet)
      else toks.push({ start, end: i, color: commands.has(word) ? C.cmd : C.bad });
      continue;
    }
    if (/^--?[A-Za-z0-9]/.test(word)) {
      const eq = word.indexOf("=");
      toks.push({ start, end: eq > 0 ? start + eq : i, color: C.flag });
    }
    toks.push(...parts);
  }
  return toks;
}

/**
 * Draws the colours of the command being typed as xterm decorations over the shell's own
 * text (needs the shell integration: OSC 133 B marks where the input starts).
 */
export class InputHighlighter {
  private decos: IDecoration[] = [];
  private sig = "";
  private queued = false;
  private disposed = false;
  enabled = true;

  constructor(private term: Terminal, private blocks: ShellBlocks) {
    const schedule = () => this.schedule();
    term.onWriteParsed(schedule);
    term.onCursorMove(schedule);
    blocks.onSubmit = () => {
      // keep the colours on the submitted line; they go away with the scrollback
      this.decos = [];
      this.sig = "";
    };
    blocks.finished.push((b) => {
      if (b.exit === 127) loadCommands(true); // "command not found": maybe it was just installed
    });
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) this.clear();
    else this.schedule();
  }

  private clear() {
    this.decos.forEach((d) => d.dispose());
    this.decos = [];
    this.sig = "";
  }

  /** The frame already asked for (or the command list still loading) must not touch the closed terminal. */
  dispose() {
    this.disposed = true;
  }

  private schedule() {
    if (!this.enabled || this.queued || this.disposed) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      if (!this.disposed) this.update();
    });
  }

  private update() {
    const b = this.blocks;
    const buf = this.term.buffer.active;
    if (!b.atPrompt || buf.type !== "normal" || !b.input) return this.sig && this.clear();
    if (!commands) loadCommands().then(() => { this.sig = "_"; this.schedule(); });

    // the command line: from the B mark to the last wrapped row, as cells → chars
    const chars: { ch: string; x: number; y: number }[] = [];
    const cursorAbs = buf.baseY + buf.cursorY;
    for (let y = b.input.marker.line; y < buf.length; y++) {
      const line = buf.getLine(y);
      if (!line || (y > b.input.marker.line && !line.isWrapped)) break;
      for (let x = y === b.input.marker.line ? b.input.x : 0; x < this.term.cols; x++) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        chars.push({ ch: cell.getChars() || " ", x, y });
      }
      if (y - b.input.marker.line > 20) break;
    }
    let text = chars.map((c) => c.ch).join("");
    const trimmed = text.replace(/\s+$/, "");
    text = trimmed;
    const sig = `${b.input.marker.line}:${b.input.x}:${text}:${commands?.size ?? 0}`;
    if (sig === this.sig) return;
    this.clear();
    this.sig = sig;
    if (!text) return;

    for (const t of lex(text)) {
      // a token may span wrapped rows: one decoration per row segment
      let k = t.start;
      while (k < t.end && k < chars.length) {
        const y = chars[k].y;
        let e = k;
        while (e + 1 < t.end && e + 1 < chars.length && chars[e + 1].y === y) e++;
        const marker = this.term.registerMarker(y - cursorAbs);
        if (marker) {
          const d = this.term.registerDecoration({
            marker, x: chars[k].x, width: chars[e].x - chars[k].x + 1, foregroundColor: t.color, layer: "top",
          });
          if (d) {
            d.onDispose(() => marker.dispose());
            this.decos.push(d);
          } else marker.dispose();
        }
        k = e + 1;
      }
    }
  }
}
