import { describe, expect, it } from "vitest";
import { relTo } from "../../src/modules/paths";

describe("paths relative to the git root", () => {
  it("unix", () => {
    expect(relTo("/home/a/repo", "/home/a/repo/src/main.rs")).toBe("src/main.rs");
    expect(relTo("/home/a/repo", "/home/a/repo")).toBe("");
    expect(relTo("/home/a/repo", "/home/a/repo2/x")).toBeNull();
    expect(relTo("", "/x")).toBeNull();
  });
  it("Windows: git says C:/…, the app has C:\\… (and the drive letter case may differ)", () => {
    expect(relTo("C:/Users/x/infra", "C:\\Users\\x\\infra\\modules\\main.tf")).toBe("modules/main.tf");
    expect(relTo("C:/Users/x/infra", "c:\\users\\x\\infra/main.tf")).toBe("main.tf");
    expect(relTo("C:/Users/x/infra", "D:\\Users\\x\\infra\\main.tf")).toBeNull();
  });
});
