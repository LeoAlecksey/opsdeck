import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../../src/modules/ui", () => ({ esc: (s: string) => s, toast: vi.fn() }));
vi.mock("../../src/i18n", () => ({ t: (s: string) => s }));
const { parts } = await import("../../src/modules/aichat");

describe("local AI chat answers", () => {
  it("splits text and code blocks", () => {
    const p = parts("Вот так:\n\n```bash\nkubectl get pods\n```\n\nи всё");
    expect(p.map((x) => x.kind)).toEqual(["text", "code", "text"]);
    expect(p[1]).toMatchObject({ lang: "bash", body: "kubectl get pods" });
    expect(p[0].body).toBe("Вот так:");
    expect(p[2].body, "no blank lines around the block").toBe("и всё");
  });
  it("an unfinished block while streaming is still a block", () => {
    const p = parts("```bash\nkubectl get");
    expect(p).toEqual([{ kind: "code", lang: "bash", body: "kubectl get" }]);
  });
  it("hides the reasoning of thinking models", () => {
    expect(parts("<think>hmm, the user wants…</think>\nОтвет")).toEqual([{ kind: "text", lang: "", body: "Ответ" }]);
    expect(parts("<think>still thinking")).toEqual([]);
  });
});
