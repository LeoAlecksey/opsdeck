import { describe, expect, it } from "vitest";
import { webShareCommand } from "../../src/modules/shellkind";

describe("«открыть папку в web»", () => {
  it("раздаёт только на 127.0.0.1, чтобы папка не светилась в сеть", () => {
    expect(webShareCommand(8042)).toBe("python3 -m http.server 8042 --bind 127.0.0.1");
  });
  it("в локальном шелле на Windows интерпретатор python, а не python3", () => {
    expect(webShareCommand(8042, true)).toBe("python -m http.server 8042 --bind 127.0.0.1");
  });
});
