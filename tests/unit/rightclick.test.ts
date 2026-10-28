import { describe, expect, it } from "vitest";
import { rightClickAction } from "../../src/modules/rightclick";

describe("right mouse button in the terminal (#99)", () => {
  it("«menu» leaves the click alone, with or without a selection", () => {
    expect(rightClickAction("menu", false)).toBe("menu");
    expect(rightClickAction("menu", true)).toBe("menu");
  });

  it("PuTTY mode always pastes, even over a selection", () => {
    expect(rightClickAction("paste", false)).toBe("paste");
    expect(rightClickAction("paste", true)).toBe("paste");
  });

  it("Windows Terminal mode copies a selection, otherwise pastes", () => {
    expect(rightClickAction("copy-paste", true)).toBe("copy");
    expect(rightClickAction("copy-paste", false)).toBe("paste");
  });
});
