import { describe, expect, it } from "vitest";
import { displayName, initials, normColor } from "../../src/modules/profilekit";

describe("окружения", () => {
  it("название: своё, иначе «Основное» у основного и id у остальных", () => {
    expect(displayName({ id: "default", name: "" })).toBe("Основное");
    expect(displayName({ id: "default", name: "" }, "Main")).toBe("Main");
    expect(displayName({ id: "stage-eu", name: "  " })).toBe("stage-eu");
    expect(displayName({ id: "stage-eu", name: " Стенд " })).toBe("Стенд");
  });

  it("цвет попадает в style только как #rrggbb", () => {
    expect(normColor("#EF5F6B")).toBe("#ef5f6b");
    for (const bad of ["", "red", "#fff", "#12345g", "#123456;background:url(x)", "var(--x)"]) expect(normColor(bad)).toBe("");
  });

  it("метка из двух букв", () => {
    expect(initials("Прод")).toBe("ПР");
    expect(initials("Stage EU")).toBe("SE");
    expect(initials("prod-k8s")).toBe("PK");
    expect(initials("")).toBe("?");
  });
});
