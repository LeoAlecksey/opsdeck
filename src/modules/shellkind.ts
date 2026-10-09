/** What runs in a terminal pane, as pty_spawn reports it. */
export type Launched = { program: string; args: string[] };

/** File name without folder and .exe, lowercase: "C:\\...\\pwsh.exe" → "pwsh". */
function stem(program: string): string {
  return (program.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, "").toLowerCase();
}

export const isWsl = (l: Launched | null): boolean => !!l && stem(l.program) === "wsl";

/** On Windows the console host (ConPTY) reports the program's path as the title until the program sets its own:
 *  "C:\\WINDOWS\\System32\\wsl.exe" for a WSL tab. Not worth replacing the tab's name with. */
export const isProgramPath = (title: string, program: string | undefined): boolean =>
  !!program && /^([a-z]:\\|\\\\)/i.test(title) && stem(title) === stem(program);

const SHELLS = ["bash", "zsh", "fish", "sh", "powershell", "pwsh", "cmd"];

/** The pane's shell for the AI context: "pwsh", "bash", "wsl:<distro>"; null when unknown (ssh, other programs). */
export function shellName(l: Launched | null): string | null {
  if (!l) return null;
  const s = stem(l.program);
  if (s === "wsl") {
    const i = l.args.findIndex((a) => a === "-d" || a === "--distribution");
    return `wsl:${i >= 0 ? l.args[i + 1] ?? "" : ""}`;
  }
  return SHELLS.includes(s) ? s : null;
}

/**
 * The line that moves the shell into `dir`, or null when it can't be done by typing (WSL: a Windows path
 * is not the distro's). bash/zsh/fish/sh quote with '…'; PowerShell with '…' ('' inside); cmd with "…" and /d.
 */
export function cdCommand(l: Launched | null, dir: string): string | null {
  const s = l ? stem(l.program) : "";
  if (s === "wsl") return null;
  if (s === "powershell" || s === "pwsh") return `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'`;
  if (s === "cmd") return `cd /d "${dir.replace(/"/g, "")}"`;
  return `cd -- ${/^[\w@%+=:,./~-]+$/.test(dir) ? dir : `'${dir.replace(/'/g, `'\\''`)}'`}`;
}
