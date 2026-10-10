import { describe, expect, it } from "vitest";
import { natCmp } from "../../src/modules/natsort";

describe("natural sort", () => {
  it("numbers go by value, not letter by letter", () => {
    expect(["TL-10", "TL-2", "TL-1", "TL-11", "TL-12"].sort(natCmp)).toEqual(["TL-1", "TL-2", "TL-10", "TL-11", "TL-12"]);
    expect(["mng-14-1", "mng-1-2", "mng-1-10", "mng-1-1"].sort(natCmp)).toEqual(["mng-1-1", "mng-1-2", "mng-1-10", "mng-14-1"]);
  });
  it("case does not matter, plain words stay alphabetical", () => {
    expect(["b", "A", "c"].sort(natCmp)).toEqual(["A", "b", "c"]);
    expect(["host2", "Host10", "host1"].sort(natCmp)).toEqual(["host1", "host2", "Host10"]);
  });
});
