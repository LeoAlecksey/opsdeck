import { describe, expect, it } from "vitest";
import { clip, diffContext, fenced, fileContext, projectContext } from "../../src/modules/aictx";

describe("IDE → AI context", () => {
  it("clips long text and says how much was cut", () => {
    expect(clip("abc", 10)).toBe("abc");
    expect(clip("a".repeat(15), 10)).toContain("ещё 5 символов");
  });

  it("the fence is longer than any backticks inside", () => {
    expect(fenced("x")).toBe("```\nx\n```");
    expect(fenced("a ``` b")).toMatch(/^````\n.*\n````$/s);
  });

  it("a file or a selection, with its place", () => {
    expect(fileContext("/p/a.tf", "x = 1\n", null)).toContain("Файл /p/a.tf:");
    expect(fileContext("/p/a.tf", "x = 1", { from: 3, to: 5 })).toContain("строки 3–5");
  });

  it("a project: name, branch, two tree levels, changes", () => {
    const t = projectContext({
      name: "infra", path: "/home/u/infra", branch: "main",
      tree: { "": ["modules/", "main.tf"], modules: ["vpc/", "db/"] },
      changes: { "main.tf": " M", "new.tf": "??" },
    });
    expect(t).toContain("Проект «infra» (/home/u/infra), ветка main.");
    expect(t).toContain("modules/\n  vpc/\n  db/\nmain.tf");
    expect(t).toContain("M  main.tf");
    expect(projectContext({ name: "x", path: "/x", branch: "", tree: {}, changes: {} })).toContain("чисто");
  });

  it("the diff names how many files were left out", () => {
    const t = diffContext("/p", [{ file: "a", diff: "+x" }], 4);
    expect(t).toContain("показаны 1 из 4");
    expect(t).toContain("# a\n+x");
  });
});
