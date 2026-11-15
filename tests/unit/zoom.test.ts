import { describe, expect, it } from "vitest";
import { nextZoom, zoomKey } from "../../src/modules/zoom";

const k = (key: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe("zoom in IDE and notes", () => {
  it("Ctrl or Cmd with = + - 0", () => {
    expect(zoomKey(k("=", { ctrlKey: true }))).toBe(1);
    expect(zoomKey(k("+", { ctrlKey: true }))).toBe(1);
    expect(zoomKey(k("-", { metaKey: true }))).toBe(-1);
    expect(zoomKey(k("0", { ctrlKey: true }))).toBe(0);
    expect(zoomKey(k("=", {}))).toBeNull();
    expect(zoomKey(k("=", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(zoomKey(k("s", { ctrlKey: true }))).toBeNull();
  });

  it("steps of 10% within 70–200%, 0 goes back to 100%", () => {
    expect(nextZoom(1, 1)).toBe(1.1);
    expect(nextZoom(1.1, -1)).toBe(1);
    expect(nextZoom(0.7, -1)).toBe(0.7);
    expect(nextZoom(2, 1)).toBe(2);
    expect(nextZoom(1.6, 0)).toBe(1);
    // no float drift after many steps
    let z = 1;
    for (let i = 0; i < 7; i++) z = nextZoom(z, 1);
    expect(z).toBe(1.7);
  });
});
