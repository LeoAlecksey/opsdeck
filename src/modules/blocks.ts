import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";

/** One command run, delimited by OSC 133 marks emitted by the shell integration. */
export type Block = {
  prompt: IMarker;
  output?: IMarker;
  end?: IMarker;
  command: string;
  exit?: number;
  started?: number;
  duration?: number;
  deco?: IDecoration;
};

const MAX_BLOCKS = 1000;

function decodeB64(s: string): string {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
  } catch {
    return "";
  }
}

/**
 * Parses OSC 133 (A prompt, B input, C output, D;exit, E;base64 command) and OSC 7 (cwd)
 * into command blocks with buffer markers, and marks them in the overview ruler.
 */
export class ShellBlocks {
  readonly blocks: Block[] = [];
  cwd = "";
  /** Where the command line starts (OSC 133 B): buffer marker + column. */
  input: { marker: IMarker; x: number } | null = null;
  onFinished?: (b: Block) => void;
  /** Extra listeners for finished commands (onFinished belongs to the terminal view). */
  readonly finished: ((b: Block) => void)[] = [];
  /** Called on C: the typed command has been submitted. */
  onSubmit?: () => void;
  private cur: Block | null = null;

  constructor(private term: Terminal) {
    term.parser.registerOscHandler(133, (data) => { this.osc(data); return true; });
    term.parser.registerOscHandler(7, (data) => {
      // file://HOST/C:/Users/… on Windows: drop the slash before the drive letter
      try { this.cwd = decodeURIComponent(new URL(data).pathname).replace(/^\/([A-Za-z]:)/, "$1"); } catch { /* ignore */ }
      return true;
    });
  }

  /** Command currently running in the foreground (between OSC 133 C and D), if any. */
  get running(): string | null {
    return this.cur?.output && this.cur.exit === undefined ? this.cur.command : null;
  }

  /** The shell shows its prompt and the user is typing (between B and C). */
  get atPrompt(): boolean {
    return !!this.cur && !this.cur.output && !!this.input && !this.input.marker.isDisposed;
  }

  /** Between A and C: the prompt itself is being drawn or edited (not command output). */
  get inPrompt(): boolean {
    return !!this.cur && !this.cur.output;
  }

  /** True once the shell has emitted marks, i.e. shell integration is active. */
  get active() {
    return this.blocks.length > 0 || this.cur !== null;
  }

  private mark() {
    return this.term.registerMarker(0) ?? undefined;
  }

  private osc(data: string) {
    const [kind, ...rest] = data.split(";");
    switch (kind) {
      case "A": {
        const prompt = this.mark();
        this.cur = prompt ? { prompt, command: "" } : null;
        this.input = null;
        break;
      }
      case "B": {
        const marker = this.mark();
        this.input = marker ? { marker, x: this.term.buffer.active.cursorX } : null;
        break;
      }
      case "E":
        if (this.cur) this.cur.command = decodeB64(rest.join(";")).trim();
        break;
      case "C":
        this.onSubmit?.();
        this.input = null;
        if (this.cur) {
          this.cur.output = this.mark();
          this.cur.started = Date.now();
        }
        break;
      case "D": {
        const b = this.cur;
        this.cur = null;
        // D is also sent for the very first prompt and for empty lines: only close real commands
        if (!b?.output || !b.command) return;
        b.exit = Number(rest[0] ?? 0) || 0;
        b.end = this.mark();
        b.duration = Date.now() - (b.started ?? Date.now());
        b.deco = this.term.registerDecoration({
          marker: b.prompt,
          overviewRulerOptions: { color: b.exit === 0 ? "#98d98299" : "#ef5f6b", position: "left" },
        }) ?? undefined;
        this.blocks.push(b);
        if (this.blocks.length > MAX_BLOCKS) {
          const old = this.blocks.shift()!;
          old.deco?.dispose();
        }
        this.onFinished?.(b);
        this.finished.forEach((f) => f(b));
        break;
      }
    }
  }

  /** Block whose prompt..end range contains buffer line `line`. */
  at(line: number): Block | undefined {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b.prompt.isDisposed) continue;
      if (b.prompt.line <= line) return (b.end && !b.end.isDisposed && line >= b.end.line) ? undefined : b;
    }
    return undefined;
  }

  /** Output text of a block; soft-wrapped rows are joined back into single lines. */
  output(b: Block, maxLines = 5000): string {
    if (!b.output || b.output.isDisposed) return "";
    const buf = this.term.buffer.active;
    const endLine = b.end && !b.end.isDisposed ? b.end.line : buf.length;
    const start = Math.max(b.output.line, endLine - maxLines);
    const lines: string[] = [];
    for (let i = start; i < endLine; i++) {
      const l = buf.getLine(i);
      if (!l) continue;
      const text = l.translateToString(true);
      if (l.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join("\n");
  }

  /** Scrolls to the previous (-1) or next (+1) command relative to the viewport top. */
  jump(dir: -1 | 1) {
    const top = this.term.buffer.active.viewportY;
    const lines = this.blocks.filter((b) => !b.prompt.isDisposed).map((b) => b.prompt.line);
    const target = dir < 0 ? lines.filter((l) => l < top).pop() : lines.find((l) => l > top);
    if (target !== undefined) this.term.scrollToLine(target);
    else if (dir > 0) this.term.scrollToBottom();
  }
}

export function fmtDuration(ms?: number): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms} мс`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} с`;
  return `${Math.floor(ms / 60000)} мин ${Math.round((ms % 60000) / 1000)} с`;
}
