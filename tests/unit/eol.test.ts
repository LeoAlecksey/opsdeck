import { describe, expect, it } from "vitest";
import { eolOf, toLf, withEol } from "../../src/modules/eol";

describe("line endings", () => {
  it("detects, normalizes and restores", () => {
    const win = "# Title\r\nline 1\r\nline 2\r\n";
    expect(eolOf(win)).toBe("\r\n");
    expect(eolOf("a\nb")).toBe("\n");
    expect(toLf(win)).toBe("# Title\nline 1\nline 2\n");
    expect(withEol(toLf(win) + "added\n", "\r\n")).toBe(win + "added\r\n");
    expect(withEol("a\nb", "\n")).toBe("a\nb");
    expect(withEol("mixed\r\nand\n", "\r\n")).toBe("mixed\r\nand\r\n"); // no "\r\r\n"
  });
});
