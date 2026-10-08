import { describe, expect, it, vi } from "vitest";

// taskkit also holds the task dialog: its DOM/Tauri imports are not needed for the parsers
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../../src/modules/ui", () => ({ esc: (s: string) => s, overlay: vi.fn(), toast: vi.fn() }));
const { tagsOf, setFrontTags, ymd, addDays } = await import("../../src/modules/taskkit");

describe("tags", () => {
  it("front matter (inline and list) and #tags in the text", () => {
    const text = "---\ntags: [runbook, \"shop\"]\naliases: x\n---\n# Heading\nText #prod and #k8s/ingress, not #123.\n`#code` and\n```\n#fenced\n```";
    const t = tagsOf(text);
    expect(t.front).toEqual(["runbook", "shop"]);
    expect(t.all).toEqual(["runbook", "shop", "prod", "k8s/ingress"]);
    expect(tagsOf("---\ntags:\n  - a\n  - b\n---\nbody").front).toEqual(["a", "b"]);
    expect(tagsOf("Кириллица #дежурство").all).toEqual(["дежурство"]);
  });

  it("set the front matter tags", () => {
    expect(setFrontTags("body", ["a", "b"])).toBe("---\ntags: [a, b]\n---\nbody");
    expect(setFrontTags("---\ntitle: x\ntags:\n  - old\n---\nbody", ["new"])).toBe("---\ntags: [new]\ntitle: x\n---\nbody");
    expect(setFrontTags("---\ntags: [a]\n---\nbody", [])).toBe("body");
    expect(setFrontTags("body", [])).toBe("body");
  });
});

describe("dates", () => {
  it("ymd and addDays", () => {
    expect(ymd(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(ymd(addDays(new Date(2026, 11, 31), 1))).toBe("2027-01-01");
    expect(ymd(addDays(new Date(2026, 2, 1), -1))).toBe("2026-02-28");
  });
});
