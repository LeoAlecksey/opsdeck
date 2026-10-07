import { describe, expect, it } from "vitest";

const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
const events: string[] = [];
(globalThis as any).window = { dispatchEvent: (e: CustomEvent) => events.push(e.detail) };
(globalThis as any).CustomEvent ??= class<T> extends Event { detail: T; constructor(t: string, o: { detail: T }) { super(t); this.detail = o.detail; } };
const a = await import("../../src/modules/ai-agents");

describe("AI agents", () => {
  it("defaults to Claude Code and ignores unknown names", () => {
    expect(a.aiAgent()).toBe("Claude Code");
    mem.set("opsdeck.ai.provider", "Something");
    expect(a.aiAgent()).toBe("Claude Code");
    a.setAiAgent("Nope");
    expect(events).toEqual([]);
  });
  it("remembers the choice and announces only changes", () => {
    a.setAiAgent("OpenCode");
    a.setAiAgent("OpenCode");
    expect(a.aiAgent()).toBe("OpenCode");
    expect(events).toEqual(["OpenCode"]);
  });
  it("file references", () => {
    expect(a.fileRef("/n/a.md", null, null)).toBe("@/n/a.md");
    expect(a.fileRef("/n/a.md", 3, 7)).toBe("@/n/a.md#L3-L7");
  });
});
