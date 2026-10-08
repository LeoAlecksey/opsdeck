import { describe, expect, it } from "vitest";
import { matches, parseSelector } from "../../src/modules/labelsel";

const pod = { app: "api", tier: "backend", env: "prod" };

describe("label selectors (kubectl -l)", () => {
  it("equality and inequality", () => {
    expect(matches(parseSelector("app=api"), pod)).toBe(true);
    expect(matches(parseSelector("app==api"), pod)).toBe(true);
    expect(matches(parseSelector("app=web"), pod)).toBe(false);
    expect(matches(parseSelector("tier!=db"), pod)).toBe(true);
    expect(matches(parseSelector("canary!=true"), pod), "a missing key is not equal").toBe(true);
  });

  it("sets, existence and AND of terms", () => {
    expect(matches(parseSelector("env in (prod, stage)"), pod)).toBe(true);
    expect(matches(parseSelector("env notin (prod)"), pod)).toBe(false);
    expect(matches(parseSelector("app"), pod)).toBe(true);
    expect(matches(parseSelector("!canary"), pod)).toBe(true);
    expect(matches(parseSelector("app=api, env in (dev,stage)"), pod)).toBe(false);
    expect(matches(parseSelector("app=api,tier=backend"), pod)).toBe(true);
    expect(matches(parseSelector("app"), undefined)).toBe(false);
    expect(parseSelector("  ")).toEqual([]);
  });

  it("broken terms are reported", () => {
    expect(() => parseSelector("app=api, =x")).toThrow(/не понял/);
    expect(() => parseSelector("env in prod")).toThrow(/не понял/);
  });
});
