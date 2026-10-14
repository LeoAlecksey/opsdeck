import { describe, expect, it } from "vitest";
import { fmtSize, joinPath } from "../../src/modules/paths";

describe("файлы на хостах", () => {
  it("путь собирается через «/», как в sftp, и «..» поднимает на уровень", () => {
    expect(joinPath("/srv", "releases")).toBe("/srv/releases");
    expect(joinPath("/srv/", "releases")).toBe("/srv/releases");
    expect(joinPath("/srv/releases", "..")).toBe("/srv");
    expect(joinPath("/srv", "..")).toBe("/");
    expect(joinPath("/", "..")).toBe("/");
    expect(joinPath("", "dump 1.sql")).toBe("/dump 1.sql");
  });
  it("размер — в удобных единицах", () => {
    expect(fmtSize(0)).toBe("0 B");
    expect(fmtSize(900)).toBe("900 B");
    expect(fmtSize(1536)).toBe("1.5 KB");
    expect(fmtSize(1048576)).toBe("1.0 MB");
    expect(fmtSize(123 * 1024 * 1024)).toBe("123 MB");
  });
});
