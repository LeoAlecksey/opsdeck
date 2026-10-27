import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { ShellBlocks } from "../../src/modules/blocks";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const { AutoSuggest } = await import("../../src/modules/suggest");
const { InputHighlighter } = await import("../../src/modules/highlight");

/** A terminal whose buffer must not be read once the panel is closed. */
function closedTerminal() {
  const fire: (() => void)[] = [];
  let reads = 0;
  const term = {
    onWriteParsed: (f: () => void) => fire.push(f),
    onCursorMove: (f: () => void) => fire.push(f),
    get buffer() { reads++; return { active: { type: "normal", baseY: 0, cursorY: 0, cursorX: 0, length: 0, getLine: () => undefined } }; },
  } as unknown as Terminal;
  return { term, typed: () => fire.forEach((f) => f()), reads: () => reads };
}

const blocks = () => ({ atPrompt: true, input: { x: 0, marker: { line: 0 } }, blocks: [], finished: [] }) as unknown as ShellBlocks;

describe("terminal panel closed", () => {
  let frames: FrameRequestCallback[];
  beforeEach(() => {
    vi.useFakeTimers();
    frames = [];
    vi.stubGlobal("window", { setTimeout, addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    invoke.mockReset();
  });

  it("the suggestion timer does not fire after dispose", () => {
    const t = closedTerminal();
    const s = new AutoSuggest(t.term, blocks(), () => {});
    t.typed();
    s.dispose();
    vi.advanceTimersByTime(1000);
    expect(t.reads()).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("the input colouring frame does not run after dispose", () => {
    const t = closedTerminal();
    const h = new InputHighlighter(t.term, blocks());
    t.typed();
    expect(frames).toHaveLength(1);
    h.dispose();
    frames.forEach((f) => f(0));
    t.typed();
    expect(frames).toHaveLength(1);
    expect(t.reads()).toBe(0);
  });
});
