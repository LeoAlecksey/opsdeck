import { describe, expect, it } from "vitest";
import { hclBalance } from "../../src/modules/hcl";
import { fileIcon, folderIcon } from "../../src/modules/fileicons";

describe("terraform check without terraform", () => {
  it("balanced code passes, comments/strings/heredocs are skipped", () => {
    const ok = 'resource "x" "y" {\n  a = "{not a brace"\n  # } comment\n  b = <<EOT\n  }}}\nEOT\n  c = [1, 2]\n}\n';
    expect(hclBalance(ok)).toEqual([]);
  });
  it("reports unclosed and extra braces with lines", () => {
    expect(hclBalance('resource "x" "y" {\n  a = 1\n')).toEqual([{ line: 1, message: "не закрыта «{»" }]);
    expect(hclBalance("a = 1\n}\n")).toEqual([{ line: 2, message: "лишняя «}»" }]);
    expect(hclBalance('a = "open\n')).toEqual([{ line: 1, message: "не закрыта кавычка" }]);
    expect(hclBalance("a = <<EOT\ntext\n")[0].message).toContain("heredoc");
  });
});

describe("file icons", () => {
  it("known types get a letter, unknown a plain page", () => {
    expect(fileIcon("infra/main.tf")).toContain(">T<");
    expect(fileIcon("deploy/app.yaml")).toContain(">Y<");
    expect(fileIcon("values.yaml")).not.toContain(">Y<"); // Helm values get the helm wheel
    expect(fileIcon("Dockerfile.prod")).toBe(fileIcon("Dockerfile"));
    expect(fileIcon("unknown.zzz")).toContain("<path");
    expect(folderIcon("src", true)).not.toBe(folderIcon("src"));
  });
});
