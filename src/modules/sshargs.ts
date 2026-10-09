/**
 * Arguments of an `ssh` command → [safe options…, destination] for the resource bar, or null when it
 * is not an interactive session. Read the way OpenSSH reads them (ssh.c, main): flags may be grouped
 * (-4v), a value may be attached or separate (-p2222 / -p 2222), options may also follow the
 * destination (ssh host -p 2222), "--" ends the options; any other word after the destination is a
 * remote command.
 */

// getopt string of ssh.c: "1246ACGKMNTVXYZafgknqstvxy" + "B:D:E:F:I:J:L:O:P:Q:R:S:W:b:c:e:i:l:m:o:p:w:"
const WITH_VALUE = new Set("BDEFIJLOPQRSWbceilmopw");
/** options the resource bar passes on to its own ssh */
const KEEP = new Set(["p", "l", "i", "J"]);

export function sshTarget(args: string[]): string[] | null {
  const keep: string[] = [];
  let dest: string | null = null;
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (options && t === "--") {
      options = false;
      continue;
    }
    if (options && t.length > 1 && t.startsWith("-")) {
      for (let j = 1; j < t.length; j++) {
        const o = t[j];
        if (!WITH_VALUE.has(o)) continue;
        const v = j + 1 < t.length ? t.slice(j + 1) : args[++i];
        // ssh refuses an option without its value: no session
        if (v === undefined) return null;
        if (KEEP.has(o)) keep.push(`-${o}`, v);
        break;
      }
      continue;
    }
    if (dest) return null;
    dest = t;
  }
  return dest ? [...keep, dest] : null;
}
