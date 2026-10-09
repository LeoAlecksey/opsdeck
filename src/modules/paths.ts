export function cleanPath(v: string): string {
  let s = v.trim().replace(/^["']+|["']+$/g, "").trim();
  if (s.startsWith("file://")) {
    try {
      const u = new URL(s);
      s = decodeURIComponent(u.pathname);
      if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1);
    } catch {
      s = s.slice(7);
    }
  }
  if (!/^[a-zA-Z]:\\/.test(s)) {
    s = s.replace(/\\ /g, " ");
  }
  return s.trim();
}

/**
 * Paths as git reports them ("C:/Users/x/repo") and as the app builds them ("C:\Users\x\repo\src")
 * differ on Windows; compare them in one form.
 */
const norm = (p: string) => {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(s) ? s[0].toLowerCase() + s.slice(1) : s; // drive letters: c: == C:
};

/** `abs` relative to `root` with "/" separators, or null when it is outside. */
export function relTo(root: string, abs: string): string | null {
  if (!root) return null;
  const r = norm(root), a = norm(abs);
  const ci = /^[a-z]:\//.test(r); // Windows paths are case-insensitive
  const [rr, aa] = ci ? [r.toLowerCase(), a.toLowerCase()] : [r, a];
  if (aa === rr) return "";
  return aa.startsWith(rr + "/") ? a.slice(r.length + 1) : null;
}
