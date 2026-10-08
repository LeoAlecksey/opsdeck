/**
 * Kubernetes label selectors, as in `kubectl get -l`: `app=api`, `tier!=db`, `env in (prod,stage)`,
 * `env notin (dev)`, `canary` (has the key), `!canary` (has not). Terms are joined by commas (AND).
 */
export type Term =
  | { op: "eq" | "ne"; key: string; value: string }
  | { op: "in" | "notin"; key: string; values: string[] }
  | { op: "exists" | "missing"; key: string };

/** Commas inside "( … )" belong to a set, not to the list of terms. */
function splitTerms(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map((t) => t.trim()).filter(Boolean);
}

/** Parses a selector; throws with a readable message on a broken term. */
export function parseSelector(s: string): Term[] {
  return splitTerms(s).map((t) => {
    let m = /^(\S+?)\s+(in|notin)\s*\(([^)]*)\)$/i.exec(t);
    if (m) return { op: m[2].toLowerCase() as "in" | "notin", key: m[1], values: m[3].split(",").map((v) => v.trim()).filter(Boolean) };
    m = /^([^=!\s]+)\s*(!=|==|=)\s*(\S*)$/.exec(t);
    if (m) return { op: m[2] === "!=" ? "ne" : "eq", key: m[1], value: m[3] };
    m = /^!\s*([^=!\s()]+)$/.exec(t);
    if (m) return { op: "missing", key: m[1] };
    if (/^[^=!\s()]+$/.test(t)) return { op: "exists", key: t };
    throw new Error(`не понял условие «${t}»`);
  });
}

export function matches(terms: Term[], labels: Record<string, string> | undefined): boolean {
  const l = labels ?? {};
  return terms.every((t) => {
    const has = Object.prototype.hasOwnProperty.call(l, t.key);
    switch (t.op) {
      case "eq": return has && l[t.key] === t.value;
      case "ne": return !has || l[t.key] !== t.value; // like kubectl: a missing key is "not equal"
      case "in": return has && t.values.includes(l[t.key]);
      case "notin": return !has || !t.values.includes(l[t.key]);
      case "exists": return has;
      case "missing": return !has;
    }
  });
}
