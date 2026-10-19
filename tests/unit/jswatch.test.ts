import { describe, expect, it } from "vitest";
import { stallGap, stallNote } from "../../src/modules/jswatch";

describe("сторож страницы", () => {
  it("мелкие задержки не считаются зависанием", () => {
    expect(stallGap(500)).toBeNull();
    expect(stallGap(1800)).toBeNull();
  });

  it("секунды простоя попадают в журнал", () => {
    expect(stallGap(2000)).toBe(2000);
    expect(stallGap(4312.7)).toBe(4313);
  });

  it("сон компьютера — не зависание: таймеры там стоят часами", () => {
    expect(stallGap(60_000)).toBeNull();
    expect(stallGap(3 * 3600_000)).toBeNull();
  });

  it("в строке видно, когда простой начался", () => {
    const ended = new Date("2026-10-19T12:00:04.000Z").getTime();
    expect(stallNote(4000, ended)).toContain(new Date("2026-10-19T12:00:00.000Z").toLocaleTimeString());
    expect(stallNote(4000, ended)).toContain("4000 мс");
  });
});
