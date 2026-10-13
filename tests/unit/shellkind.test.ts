import { describe, expect, it } from "vitest";
import { cdCommand, isProgramPath, isWsl, shellName, wslDistro } from "../../src/modules/shellkind";

const WSL = "C:\\Windows\\System32\\wsl.exe";

describe("pane shell", () => {
  it("names local shells by program", () => {
    expect(shellName({ program: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: [] })).toBe("pwsh");
    expect(shellName({ program: "powershell.exe", args: [] })).toBe("powershell");
    expect(shellName({ program: "/bin/zsh", args: [] })).toBe("zsh");
  });

  it("WSL: the distribution from -d / --distribution", () => {
    expect(shellName({ program: WSL, args: ["-d", "Ubuntu-24.04", "--cd", "~"] })).toBe("wsl:Ubuntu-24.04");
    expect(shellName({ program: "wsl", args: ["--distribution", "Debian"] })).toBe("wsl:Debian");
    expect(shellName({ program: WSL, args: [] })).toBe("wsl:");
    expect(isWsl({ program: WSL, args: [] })).toBe(true);
    expect(isWsl({ program: "C:\\Program Files\\Git\\bin\\bash.exe", args: [] })).toBe(false);
    expect(wslDistro({ program: WSL, args: ["-d", "Ubuntu-24.04", "--cd", "~"] })).toBe("Ubuntu-24.04");
    expect(wslDistro({ program: WSL, args: [] })).toBe("");
    expect(wslDistro({ program: "C:\\Windows\\System32\\cmd.exe", args: ["-d", "x"] })).toBeNull();
    expect(wslDistro(null)).toBeNull();
  });

  it("unknown for ssh, other programs and before the start", () => {
    expect(shellName({ program: "ssh", args: ["web1"] })).toBeNull();
    expect(shellName({ program: "claude", args: [] })).toBeNull();
    expect(shellName(null)).toBeNull();
    expect(isWsl(null)).toBe(false);
  });

  it("ConPTY's title = the program's path, not a name for the tab", () => {
    expect(isProgramPath("C:\\WINDOWS\\System32\\wsl.exe", WSL)).toBe(true);
    expect(isProgramPath("C:\\Windows\\System32\\OpenSSH\\ssh.exe", "ssh")).toBe(true);
    expect(isProgramPath("\\\\server\\tools\\wsl.exe", WSL)).toBe(true);
    // the shell's own title, another program, a plain shell tab (the program is chosen by the backend)
    expect(isProgramPath("user@host: ~/src", WSL)).toBe(false);
    expect(isProgramPath("C:\\Windows\\System32\\cmd.exe", WSL)).toBe(false);
    expect(isProgramPath("C:\\WINDOWS\\System32\\wsl.exe", undefined)).toBe(false);
    expect(isProgramPath("wsl", WSL)).toBe(false);
  });

  it("a plain tab: checked against the program the backend started", () => {
    const ps = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    expect(isProgramPath(ps, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe(true);
    expect(isProgramPath(ps, "powershell.exe")).toBe(true);
    expect(isProgramPath("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(true);
    // what the shell or a program in it sets stays a name
    expect(isProgramPath("Administrator: Windows PowerShell", ps)).toBe(false);
    expect(isProgramPath("C:\\Users\\me\\src", ps)).toBe(false);
    expect(isProgramPath("vim", ps)).toBe(false);
  });
});

describe("cd into the project folder", () => {
  it("quotes for the shell that is running", () => {
    expect(cdCommand({ program: "/bin/bash", args: [] }, "/home/a/proj")).toBe("cd -- /home/a/proj");
    expect(cdCommand({ program: "/bin/zsh", args: [] }, "/home/a/my proj's")).toBe("cd -- '/home/a/my proj'\\''s'");
    expect(cdCommand({ program: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: [] }, "C:\\Users\\a\\it's")).toBe("Set-Location -LiteralPath 'C:\\Users\\a\\it''s'");
    expect(cdCommand({ program: "cmd.exe", args: [] }, "D:\\work space")).toBe('cd /d "D:\\work space"');
  });
  it("WSL can't be moved by a Windows path", () => {
    expect(cdCommand({ program: WSL, args: [] }, "C:\\proj")).toBeNull();
  });
});
