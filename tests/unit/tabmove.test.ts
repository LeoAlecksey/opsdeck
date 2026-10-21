import { describe, expect, it } from "vitest";
import { beyondWindow } from "../../src/modules/winid";

describe("вкладку утащили за край окна", () => {
  it("внутри окна это обычное перетаскивание", () => {
    expect(beyondWindow(100, 100, 1440, 900)).toBe(false);
    expect(beyondWindow(0, 0, 1440, 900)).toBe(false);
    expect(beyondWindow(1440, 900, 1440, 900)).toBe(false);
  });

  it("у самого края тоже: там курсор оказывается снаружи и при обычном перетаскивании", () => {
    expect(beyondWindow(-10, 450, 1440, 900)).toBe(false);
    expect(beyondWindow(1450, 450, 1440, 900)).toBe(false);
  });

  it("дальше запаса — это вынос в отдельное окно", () => {
    expect(beyondWindow(-60, 450, 1440, 900)).toBe(true);
    expect(beyondWindow(1600, 450, 1440, 900)).toBe(true);
    expect(beyondWindow(700, -80, 1440, 900)).toBe(true);
    expect(beyondWindow(700, 1000, 1440, 900)).toBe(true);
  });
});
