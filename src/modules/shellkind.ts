/** What runs in a terminal pane, as pty_spawn reports it. */
export type Launched = { program: string; args: string[] };

/** File name without folder and .exe, lowercase: "C:\\...\\pwsh.exe" → "pwsh". */
function stem(program: string): string {
  return (program.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, "").toLowerCase();
}

export const isWsl = (l: Launched | null): boolean => !!l && stem(l.program) === "wsl";

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
