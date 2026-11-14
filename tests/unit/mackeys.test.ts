import { describe, expect, it } from "vitest";
import { macNav, type KeyLike } from "../../src/modules/mackeys";

const k = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key, metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, ...mods });

describe("macOS keys in the terminal (#122)", () => {
  it("Cmd: start and end of the line, erase to the start", () => {
    expect(macNav(k("ArrowLeft", { metaKey: true }))?.seq).toBe("\x01");
    expect(macNav(k("ArrowRight", { metaKey: true }))).toEqual({ seq: "\x05", like: { key: "End" } });
    expect(macNav(k("Backspace", { metaKey: true }))?.seq).toBe("\x15");
  });

  it("Option: a word back and forward, erase a word", () => {
    expect(macNav(k("ArrowLeft", { altKey: true }))?.seq).toBe("\x1bb");
    expect(macNav(k("ArrowRight", { altKey: true }))).toEqual({ seq: "\x1bf", like: { key: "ArrowRight", ctrlKey: true } });
    expect(macNav(k("Backspace", { altKey: true }))?.seq).toBe("\x17");
  });

  it("other keys and combinations are left alone", () => {
    expect(macNav(k("ArrowLeft"))).toBeNull();
    expect(macNav(k("ArrowLeft", { metaKey: true, shiftKey: true }))).toBeNull(); // selection
    expect(macNav(k("ArrowLeft", { metaKey: true, altKey: true }))).toBeNull(); // window managers
    expect(macNav(k("ArrowLeft", { altKey: true, ctrlKey: true }))).toBeNull();
    expect(macNav(k("c", { metaKey: true }))).toBeNull(); // Cmd+C — copy
    expect(macNav(k("ArrowUp", { altKey: true }))).toBeNull();
  });
});
