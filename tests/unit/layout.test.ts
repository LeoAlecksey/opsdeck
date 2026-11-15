import { describe, expect, it } from "vitest";
import { latinKey, termSeq, type KeyLike } from "../../src/modules/layout";

const k = (key: string, code: string, mods: Partial<KeyLike> = {}): KeyLike =>
  ({ key, code, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });

describe("shortcuts on the Russian layout", () => {
  it("the Latin key comes from the key position", () => {
    expect(latinKey(k("с", "KeyC", { ctrlKey: true }))).toBe("c");
    expect(latinKey(k("С", "KeyC", { ctrlKey: true, shiftKey: true }))).toBe("C");
    expect(latinKey(k("х", "BracketLeft", { ctrlKey: true }))).toBe("[");
    expect(latinKey(k("ъ", "BracketRight", { metaKey: true }))).toBe("]");
    expect(latinKey(k(".", "Slash", { ctrlKey: true }))).toBeNull(); // «.» on the Russian Slash key is ASCII: leave it
  });

  it("Latin layouts and plain typing are left alone", () => {
    expect(latinKey(k("c", "KeyC", { ctrlKey: true }))).toBeNull();
    expect(latinKey(k("j", "KeyC", { ctrlKey: true }))).toBeNull(); // Dvorak: the letter wins
    expect(latinKey(k("с", "KeyC"))).toBeNull(); // typing Russian text
    expect(latinKey(k("ArrowLeft", "ArrowLeft", { ctrlKey: true }))).toBeNull();
  });

  it("terminal: Ctrl gives the control byte, Alt the ESC prefix", () => {
    expect(termSeq(k("с", "KeyC", { ctrlKey: true }))).toBe("\x03");
    expect(termSeq(k("к", "KeyR", { ctrlKey: true }))).toBe("\x12");
    expect(termSeq(k("в", "KeyD", { ctrlKey: true }))).toBe("\x04");
    expect(termSeq(k("и", "KeyB", { altKey: true }))).toBe("\x1bb");
    expect(termSeq(k("ю", "Period", { altKey: true }))).toBe("\x1b.");
    expect(termSeq(k("ц", "KeyW", { ctrlKey: true, altKey: true }))).toBe("\x1b\x17");
    expect(termSeq(k("х", "BracketLeft", { ctrlKey: true }))).toBe("\x1b");
  });

  it("terminal: OpsDeck's own Ctrl+Shift and Cmd shortcuts are not touched", () => {
    expect(termSeq(k("С", "KeyC", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(termSeq(k("с", "KeyC", { metaKey: true }))).toBeNull();
    expect(termSeq(k("с", "KeyC", { ctrlKey: true }))).not.toBeNull();
  });
});
