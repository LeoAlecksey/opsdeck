/**
 * Reads a CI pipeline as a graph: what jobs there are, what waits for what, and what would run for a chosen
 * branch and event — without pushing anything. GitLab CI (`.gitlab-ci.yml` with `include: local`, `extends`,
 * anchors, `!reference`) and GitHub Actions (`.github/workflows/*.yml`).
 *
 * What cannot be known locally is never guessed: such a job gets the status "unknown" with the reason, see
 * `Planned.status`. Project variables, protected branches, remote `include:` and dynamic child pipelines are
 * outside the file, so the result is a plan, not a promise.
 */
import { parse as parseYaml } from "yaml";

export type Trigger = "push" | "merge_request" | "tag" | "schedule" | "manual" | "pull_request" | "release" | "other";

/** What the pipeline is asked about: the branch, the event and what has changed. */
export type RunCtx = {
  event: Trigger;
  branch: string;
  tag?: string;
  /** paths changed in the commit / MR, for `rules:changes` and `on.push.paths` */
  changes?: string[];
  /** variables set by hand (project and group variables are not visible from the file) */
  vars?: Record<string, string>;
  defaultBranch?: string;
};

export type Job = {
  name: string;
  stage: string;
  /** jobs this one waits for; empty with `needsDeclared` means "the whole previous stage" */
  needs: string[];
  needsDeclared: boolean;
  /** `when:` of the job itself (rules may override it) */
  when: string;
  allowFailure: boolean;
  rules?: any[];
  only?: any;
  except?: any;
  /** a child pipeline: its jobs are not known from this file */
  trigger?: string;
  /** how many copies (`parallel:`), including a matrix */
  parallel?: number;
  /** where it is declared: file and line (to open it in the editor) */
  file: string;
  line: number;
  extendsFrom: string[];
  image?: string;
};

export type Pipeline = {
  kind: "gitlab" | "github";
  /** the workflow's own name (GitHub) */
  name?: string;
  stages: string[];
  jobs: Job[];
  /** files that could not be read (remote include, a template from another project) */
  unresolved: string[];
  /** GitLab `workflow:rules` / GitHub `on:` */
  workflow?: any;
  errors: string[];
};

export type Status = "run" | "manual" | "skip" | "unknown";
export type Planned = { job: Job; status: Status; reason: string };

// ---------- YAML with GitLab's own tags ----------

const REF = "__reference__";
const refTag = { tag: "!reference", collection: "seq" as const, resolve: (seq: any) => ({ [REF]: (seq.toJSON ? seq.toJSON() : seq) as string[] }) };

export function readYaml(text: string): any {
  return parseYaml(text, { merge: true, customTags: [refTag], uniqueKeys: false, strict: false }) ?? {};
}

const isObj = (v: any): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** `!reference [.job, script]` → the value at that path in the whole document. */
function resolveReferences(node: any, root: any, depth = 0): any {
  if (depth > 10 || !node || typeof node !== "object") return node;
  if (isObj(node) && Array.isArray(node[REF])) {
    let v: any = root;
    for (const k of node[REF]) v = isObj(v) || Array.isArray(v) ? (v as any)?.[k] : undefined;
    return resolveReferences(v, root, depth + 1);
  }
  if (Array.isArray(node)) {
    // a !reference inside a script list splices its lines in, as GitLab does
    const out: any[] = [];
    for (const item of node) {
      const r = resolveReferences(item, root, depth + 1);
      if (Array.isArray(r) && isObj(item) && Array.isArray(item[REF])) out.push(...r);
      else out.push(r);
    }
    return out;
  }
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(node)) out[k] = resolveReferences(v, root, depth + 1);
  return out;
}

/** GitLab merges `extends` as a deep merge of maps; arrays and scalars are replaced. */
function deepMerge(base: any, over: any): any {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

function applyExtends(name: string, doc: Record<string, any>, seen: string[] = []): any {
  const node = doc[name];
  if (!isObj(node)) return node;
  const parents = typeof node.extends === "string" ? [node.extends] : Array.isArray(node.extends) ? node.extends : [];
  if (!parents.length) return node;
  if (seen.includes(name)) return node; // a cycle in extends: stop, do not hang
  let base: any = {};
  for (const p of parents) {
    if (!(p in doc)) continue;
    base = deepMerge(base, applyExtends(p, doc, [...seen, name]));
  }
  const { extends: _drop, ...own } = node;
  return deepMerge(base, own);
}

/** Line of a top-level key, so a job can be opened where it is declared (the name may be quoted). */
function lineOf(text: string, key: string): number {
  const name = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^[ \\t]{0,2}(?:"${name}"|'${name}'|${name})[ \\t]*:`, "m");
  const m = re.exec(text);
  return m ? text.slice(0, m.index).split("\n").length : 1;
}

// ---------- GitLab ----------

const GITLAB_KEYWORDS = new Set(["stages", "variables", "default", "include", "workflow", "image", "services", "before_script", "after_script", "cache", "pages:deploy"]);
const isTemplate = (name: string) => name.startsWith(".");

/**
 * `files` is the project's YAML by path (relative to the repo root), `entry` is usually ".gitlab-ci.yml".
 * Only `include: local` is followed; `include: remote/project/template` is listed in `unresolved`.
 */
export function parseGitlab(files: Record<string, string>, entry = ".gitlab-ci.yml"): Pipeline {
  const out: Pipeline = { kind: "gitlab", stages: [], jobs: [], unresolved: [], errors: [] };
  const origin = new Map<string, { file: string; line: number }>();
  let doc: Record<string, any> = {};
  const seenFiles = new Set<string>();

  const load = (path: string, depth = 0) => {
    const clean = path.replace(/^\.?\//, "");
    if (depth > 10 || seenFiles.has(clean)) return;
    seenFiles.add(clean);
    const text = files[clean] ?? files["./" + clean] ?? files["/" + clean];
    if (text === undefined) { out.unresolved.push(clean); return; }
    let parsed: any;
    try { parsed = readYaml(text); } catch (e) { out.errors.push(`${clean}: ${(e as Error).message}`); return; }
    if (!isObj(parsed)) return;
    const inc = parsed.include;
    for (const i of Array.isArray(inc) ? inc : inc !== undefined ? [inc] : []) {
      if (typeof i === "string") load(i, depth + 1);
      else if (isObj(i) && i.local) load(String(i.local), depth + 1);
      else if (isObj(i)) out.unresolved.push(i.remote ?? i.template ?? (i.project ? `${i.project}: ${[].concat(i.file ?? []).join(", ")}` : JSON.stringify(i)));
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (k === "include") continue;
      doc[k] = v;
      if (!GITLAB_KEYWORDS.has(k)) origin.set(k, { file: clean, line: lineOf(text, k) });
    }
  };
  load(entry);
  doc = resolveReferences(doc, doc);

  out.stages = Array.isArray(doc.stages) ? doc.stages.map(String) : ["build", "test", "deploy"];
  out.workflow = doc.workflow;

  for (const name of Object.keys(doc)) {
    if (GITLAB_KEYWORDS.has(name) || isTemplate(name)) continue;
    const j = applyExtends(name, doc);
    if (!isObj(j) || (!j.script && !j.trigger && !j.extends && !j.run)) continue; // not a job
    const needsRaw = j.needs;
    const needs = (Array.isArray(needsRaw) ? needsRaw : needsRaw !== undefined ? [needsRaw] : [])
      .map((n: any) => (typeof n === "string" ? n : n?.job ?? n?.pipeline ?? ""))
      .filter(Boolean);
    const o = origin.get(name) ?? { file: entry, line: 1 };
    out.jobs.push({
      name, stage: String(j.stage ?? "test"), // GitLab's own default
      needs, needsDeclared: needsRaw !== undefined,
      when: String(j.when ?? "on_success"),
      allowFailure: j.allow_failure === true,
      rules: Array.isArray(j.rules) ? j.rules : undefined,
      only: j.only, except: j.except,
      trigger: j.trigger === undefined ? undefined
        : typeof j.trigger === "string" ? j.trigger
        : j.trigger.project ? String(j.trigger.project)
        : j.trigger.include ? "дочерний пайплайн" : "trigger",
      parallel: typeof j.parallel === "number" ? j.parallel : isObj(j.parallel) && isObj(j.parallel.matrix) ? undefined : Array.isArray(j.parallel?.matrix) ? j.parallel.matrix.reduce((n: number, m: any) => n + Object.values(m).reduce((p: number, v: any) => p * (Array.isArray(v) ? v.length : 1), 1), 0) : undefined,
      file: o.file, line: o.line,
      extendsFrom: typeof doc[name]?.extends === "string" ? [doc[name].extends] : Array.isArray(doc[name]?.extends) ? doc[name].extends : [],
      image: typeof j.image === "string" ? j.image : j.image?.name,
    });
  }
  // stages a job mentions but `stages:` does not list (GitLab would fail; show them at the end)
  for (const j of out.jobs) if (!out.stages.includes(j.stage) && !j.stage.startsWith(".")) out.stages.push(j.stage);
  return out;
}

// ---------- GitHub Actions ----------

export function parseGithub(path: string, text: string): Pipeline {
  const out: Pipeline = { kind: "github", stages: [], jobs: [], unresolved: [], errors: [] };
  let doc: any;
  try { doc = readYaml(text); } catch (e) { out.errors.push(`${path}: ${(e as Error).message}`); return out; }
  if (!isObj(doc)) return out;
  out.name = typeof doc.name === "string" ? doc.name : path.split("/").pop();
  // `on:` in YAML 1.1 is the boolean true, so look for both
  out.workflow = doc.on ?? doc[true as any] ?? doc["on"];
  const jobs = isObj(doc.jobs) ? doc.jobs : {};
  for (const [name, j] of Object.entries<any>(jobs)) {
    if (!isObj(j)) continue;
    const needs = typeof j.needs === "string" ? [j.needs] : Array.isArray(j.needs) ? j.needs.map(String) : [];
    const matrix = j.strategy?.matrix;
    out.jobs.push({
      name, stage: "", needs, needsDeclared: j.needs !== undefined,
      when: "on_success", allowFailure: j["continue-on-error"] === true,
      rules: j.if !== undefined ? [{ if: String(j.if) }] : undefined,
      trigger: j.uses ? String(j.uses) : undefined,
      parallel: isObj(matrix) ? Object.entries(matrix).filter(([k]) => k !== "include" && k !== "exclude")
        .reduce((n, [, v]) => n * (Array.isArray(v) ? v.length : 1), 1) + (Array.isArray(matrix.include) ? matrix.include.length : 0) || undefined : undefined,
      file: path, line: lineOf(text, name),
      extendsFrom: [], image: typeof j["runs-on"] === "string" ? j["runs-on"] : Array.isArray(j["runs-on"]) ? j["runs-on"].join(", ") : j["runs-on"]?.labels?.join?.(", "),
    });
  }
  // stages come from the needs graph: jobs with no unfinished dependency go in the same column
  out.stages = levels(out.jobs).map((_, i) => `${i + 1}`);
  return out;
}

/** Columns of the graph: a job stands to the right of everything it waits for. */
export function levels(jobs: Job[]): Job[][] {
  const byName = new Map(jobs.map((j) => [j.name, j]));
  const level = new Map<string, number>();
  const depth = (j: Job, seen: string[] = []): number => {
    if (level.has(j.name)) return level.get(j.name)!;
    if (seen.includes(j.name)) return 0; // a cycle in needs
    const d = Math.max(0, ...j.needs.map((n) => (byName.has(n) ? depth(byName.get(n)!, [...seen, j.name]) + 1 : 0)));
    level.set(j.name, d);
    return d;
  };
  const out: Job[][] = [];
  for (const j of jobs) {
    const d = depth(j);
    (out[d] ??= []).push(j);
  }
  return out.map((x) => x ?? []);
}

// ---------- expressions ----------

type Tri = true | false | "unknown";
const and = (a: Tri, b: Tri): Tri => (a === false || b === false ? false : a === "unknown" || b === "unknown" ? "unknown" : true);
const or = (a: Tri, b: Tri): Tri => (a === true || b === true ? true : a === "unknown" || b === "unknown" ? "unknown" : false);

/**
 * Predefined GitLab variables for the chosen context. The ones OpsDeck models are always set — empty when
 * they do not apply, as GitLab does (on a tag there is no CI_COMMIT_BRANCH), so `if: $CI_COMMIT_TAG` on a
 * branch is a plain "no", not an "unknown".
 */
export function gitlabVars(c: RunCtx): Record<string, string> {
  const def = c.defaultBranch ?? "main";
  const src = c.event === "merge_request" ? "merge_request_event" : c.event === "tag" ? "push" : c.event === "manual" ? "web" : c.event;
  const v: Record<string, string> = {
    CI: "true", GITLAB_CI: "true", CI_PIPELINE_SOURCE: src, CI_DEFAULT_BRANCH: def,
    CI_PROJECT_NAME: "project", CI_COMMIT_SHA: "0".repeat(40), CI_COMMIT_SHORT_SHA: "0000000",
  };
  const tag = c.event === "tag";
  const mr = c.event === "merge_request";
  v.CI_COMMIT_TAG = tag ? c.tag ?? "" : "";
  v.CI_COMMIT_BRANCH = tag || mr ? "" : c.branch;
  v.CI_COMMIT_REF_NAME = tag ? c.tag ?? "" : c.branch;
  v.CI_MERGE_REQUEST_ID = mr ? "1" : "";
  v.CI_MERGE_REQUEST_IID = mr ? "1" : "";
  v.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME = mr ? c.branch : "";
  v.CI_MERGE_REQUEST_TARGET_BRANCH_NAME = mr ? def : "";
  v.CI_OPEN_MERGE_REQUESTS = "";
  v.CI_PIPELINE_TRIGGERED = "";
  // depend on the commit, not on the choice above: empty unless the user types them in
  v.CI_COMMIT_MESSAGE = ""; v.CI_COMMIT_TITLE = ""; v.CI_COMMIT_BEFORE_SHA = "0".repeat(40); v.CI_COMMIT_AUTHOR = "";
  v.CI_COMMIT_REF_SLUG = (v.CI_COMMIT_REF_NAME ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
  return { ...v, ...(c.vars ?? {}) };
}

/** Splits on a top-level operator, respecting quotes, brackets and /regex/. */
function splitTop(s: string, op: string): string[] | null {
  const parts: string[] = [];
  let depth = 0, q: string | null = null, last = 0, inRe = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q && s[i - 1] !== "\\") q = null; continue; }
    if (inRe) { if (c === "/" && s[i - 1] !== "\\") inRe = false; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "/" && /[=~(,&|]\s*$/.test(s.slice(0, i))) { inRe = true; continue; }
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth--;
    if (!depth && s.startsWith(op, i)) { parts.push(s.slice(last, i)); i += op.length - 1; last = i + 1; }
  }
  if (!parts.length) return null;
  parts.push(s.slice(last));
  return parts;
}

const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/s, "$2");

/** `$VAR`, "text", or text with $VAR inside; undefined when the variable is not known. */
function value(expr: string, vars: Record<string, string>): string | undefined {
  const s = expr.trim();
  if (/^\$\{?\w+\}?$/.test(s)) {
    const n = s.replace(/[${}]/g, "");
    return vars[n];
  }
  if (/^(['"]).*\1$/s.test(s)) return unquote(s).replace(/\$\{?(\w+)\}?/g, (_, n) => vars[n] ?? "");
  if (s === "null") return undefined;
  return s;
}

/**
 * A GitLab `rules:if` expression: `$VAR`, `==`, `!=`, `=~ /re/`, `!~`, `&&`, `||`, parentheses.
 * Anything else is "unknown" — better than guessing.
 */
export function evalIf(expr: string, vars: Record<string, string>): Tri {
  let s = expr.trim();
  if (!s) return true;
  if (s.startsWith("(") && s.endsWith(")") && (splitTop(s, "&&") === null && splitTop(s, "||") === null)) return evalIf(s.slice(1, -1), vars);
  const ors = splitTop(s, "||");
  if (ors) return ors.map((p) => evalIf(p, vars)).reduce(or);
  const ands = splitTop(s, "&&");
  if (ands) return ands.map((p) => evalIf(p, vars)).reduce(and);
  if (s.startsWith("!") && !/^!~/.test(s) && !/^!=/.test(s)) {
    const v = evalIf(s.slice(1), vars);
    return v === "unknown" ? "unknown" : !v;
  }
  for (const op of ["=~", "!~", "==", "!="] as const) {
    const parts = splitTop(s, op);
    if (!parts || parts.length !== 2) continue;
    const [l, r] = parts.map((x) => x.trim());
    const lv = value(l, vars);
    if (op === "=~" || op === "!~") {
      const m = /^\/(.*)\/([gimsu]*)$/s.exec(r);
      if (!m) return "unknown";
      let re: RegExp;
      try { re = new RegExp(m[1], m[2]); } catch { return "unknown"; }
      const hit = re.test(lv ?? "");
      return op === "=~" ? hit : !hit;
    }
    const rv = value(r, vars);
    const eq = r.trim() === "null" ? lv === undefined || lv === "" : (lv ?? "") === (rv ?? "");
    return op === "==" ? eq : !eq;
  }
  // a bare `$VAR`: true when set and not empty
  if (/^\$\{?\w+\}?$/.test(s)) {
    const n = s.replace(/[${}]/g, "");
    return n in vars ? vars[n] !== "" && vars[n] !== "false" : "unknown";
  }
  return "unknown";
}

/** A glob of `rules:changes` / `on.push.paths`: `**` any depth, `*` inside one segment, `{a,b}`. */
export function globMatch(pattern: string, path: string): boolean {
  const p = pattern.replace(/^\.?\//, "");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") { re += p[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += p[i + 2] === "/" ? 2 : 1; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") { const end = p.indexOf("}", i); if (end < 0) { re += "\\{"; continue; } re += `(?:${p.slice(i + 1, end).split(",").map((x) => x.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("|")})`; i = end; }
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  try { return new RegExp(`^${re}$`).test(path.replace(/^\.?\//, "")); } catch { return false; }
}

const anyChange = (patterns: string[], changes: string[] | undefined): Tri =>
  changes === undefined ? "unknown" : patterns.some((p) => changes.some((f) => globMatch(p, f)));

// ---------- the plan ----------

/** GitLab `only`/`except` in their short form (refs). */
function onlyExcept(spec: any, c: RunCtx, vars: Record<string, string>): Tri {
  const refs: string[] = Array.isArray(spec) ? spec.map(String) : isObj(spec) && Array.isArray(spec.refs) ? spec.refs.map(String) : [];
  if (!refs.length) return "unknown";
  const name = vars.CI_COMMIT_REF_NAME ?? c.branch;
  return refs.some((r) => {
    if (r === "branches") return c.event !== "tag";
    if (r === "tags") return c.event === "tag";
    if (r === "merge_requests") return c.event === "merge_request";
    if (r === "schedules") return c.event === "schedule";
    if (r === "web" || r === "api" || r === "triggers") return c.event === "manual";
    const m = /^\/(.*)\/([gimsu]*)$/s.exec(r);
    if (m) { try { return new RegExp(m[1], m[2]).test(name); } catch { return false; } }
    return r === name;
  });
}

function statusOfWhen(when: string): Status {
  return when === "never" ? "skip" : when === "manual" ? "manual" : "run";
}

/** Walks `rules:` as GitLab does: the first rule that matches decides; nothing matched means the job is dropped. */
function planRules(rules: any[], c: RunCtx, vars: Record<string, string>, fallbackWhen: string): { status: Status; reason: string } {
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (!isObj(r)) continue;
    let v: Tri = true;
    const why: string[] = [];
    if (r.if !== undefined) { v = and(v, evalIf(String(r.if), vars)); why.push(`if: ${String(r.if)}`); }
    if (r.changes !== undefined) {
      const pats = (Array.isArray(r.changes) ? r.changes : r.changes?.paths ?? []).map(String);
      v = and(v, anyChange(pats, c.changes));
      why.push(`changes: ${pats.join(", ")}`);
    }
    if (r.exists !== undefined) { v = "unknown"; why.push("exists: — не проверяется локально"); }
    if (v === false) continue;
    const when = String(r.when ?? fallbackWhen);
    const reason = `rules[${i}] ${why.join("; ") || "без условия"}`;
    if (v === "unknown") return { status: "unknown", reason: `${reason} — неизвестно` };
    return { status: statusOfWhen(when), reason: when === "never" ? `${reason} → when: never` : `${reason}${when !== "on_success" ? ` → when: ${when}` : ""}` };
  }
  return { status: "skip", reason: "ни одно правило rules не сработало" };
}

/** GitHub `if:` — the usual `${{ }}` forms over github.*; anything else is "unknown". */
export function evalGithubIf(expr: string, c: RunCtx): Tri {
  const inner = expr.trim().replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "").trim();
  const ref = c.event === "tag" ? `refs/tags/${c.tag ?? ""}` : `refs/heads/${c.branch}`;
  const vars: Record<string, string> = {
    "github.event_name": c.event === "merge_request" ? "pull_request" : c.event === "tag" ? "push" : c.event === "manual" ? "workflow_dispatch" : c.event,
    "github.ref": c.event === "merge_request" ? `refs/pull/1/merge` : ref,
    "github.ref_name": c.event === "tag" ? c.tag ?? "" : c.branch,
    "github.ref_type": c.event === "tag" ? "tag" : "branch",
    "github.base_ref": c.event === "merge_request" ? c.defaultBranch ?? "main" : "",
    "github.head_ref": c.event === "merge_request" ? c.branch : "",
    "github.repository": "owner/repo",
    "github.actor": "user",
    ...(c.vars ?? {}),
  };
  const call = (s: string): Tri | null => {
    const m = /^(contains|startsWith|endsWith)\s*\((.*)\)$/s.exec(s.trim());
    if (!m) return null;
    const args = splitTop(m[2], ",") ?? [m[2]];
    if (args.length !== 2) return "unknown";
    const [a, b] = args.map((x) => {
      const t = x.trim();
      return t in vars ? vars[t] : /^(['"]).*\1$/s.test(t) ? unquote(t) : undefined;
    });
    if (a === undefined || b === undefined) return "unknown";
    return m[1] === "contains" ? a.includes(b) : m[1] === "startsWith" ? a.startsWith(b) : a.endsWith(b);
  };
  const walk = (s: string): Tri => {
    const t = s.trim();
    if (!t) return true;
    if (t.startsWith("(") && t.endsWith(")") && splitTop(t, "&&") === null && splitTop(t, "||") === null) return walk(t.slice(1, -1));
    const ors = splitTop(t, "||");
    if (ors) return ors.map(walk).reduce(or);
    const ands = splitTop(t, "&&");
    if (ands) return ands.map(walk).reduce(and);
    if (t.startsWith("!") && !t.startsWith("!=")) { const v = walk(t.slice(1)); return v === "unknown" ? "unknown" : !v; }
    const fn = call(t);
    if (fn !== null) return fn;
    for (const op of ["==", "!="] as const) {
      const parts = splitTop(t, op);
      if (!parts || parts.length !== 2) continue;
      const [l, r] = parts.map((x) => x.trim());
      const lv = l in vars ? vars[l] : /^(['"]).*\1$/s.test(l) ? unquote(l) : undefined;
      const rv = r in vars ? vars[r] : /^(['"]).*\1$/s.test(r) ? unquote(r) : undefined;
      if (lv === undefined || rv === undefined) return "unknown";
      return op === "==" ? lv === rv : lv !== rv;
    }
    if (t === "true" || t === "success()" || t === "always()") return true;
    if (t === "false") return false;
    return "unknown";
  };
  return walk(inner);
}

/** Does GitHub's `on:` start this workflow for the chosen event? */
export function githubTriggered(on: any, c: RunCtx): { ok: Tri; reason: string } {
  if (on === undefined || on === null) return { ok: "unknown", reason: "нет on:" };
  const names = typeof on === "string" ? [on] : Array.isArray(on) ? on.map(String) : Object.keys(on);
  const want = c.event === "merge_request" ? "pull_request" : c.event === "manual" ? "workflow_dispatch" : c.event === "tag" ? "push" : c.event;
  const has = (n: string) => names.includes(n);
  if (c.event === "schedule") return { ok: has("schedule"), reason: has("schedule") ? "on: schedule" : "нет on: schedule" };
  if (!has(want) && !(want === "pull_request" && has("pull_request_target"))) return { ok: false, reason: `нет on: ${want}` };
  const cfg = isObj(on) ? on[want] ?? on[want === "pull_request" ? "pull_request_target" : want] : undefined;
  if (!isObj(cfg)) return { ok: true, reason: `on: ${want}` };
  const list = (k: string): string[] | undefined => (Array.isArray(cfg[k]) ? cfg[k].map(String) : undefined);
  const refName = c.event === "tag" ? c.tag ?? "" : c.branch;
  if (c.event === "tag") {
    const tags = list("tags");
    if (tags && !tags.some((p) => globMatch(p, refName))) return { ok: false, reason: `тег ${refName} не подходит под tags: ${tags.join(", ")}` };
    if (!tags && list("branches")) return { ok: false, reason: "on: push только для веток" };
  } else {
    const br = list("branches"), ign = list("branches-ignore");
    if (br && !br.some((p) => globMatch(p, refName))) return { ok: false, reason: `ветка ${refName} не подходит под branches: ${br.join(", ")}` };
    if (ign && ign.some((p) => globMatch(p, refName))) return { ok: false, reason: `ветка ${refName} в branches-ignore` };
    if (!br && !ign && c.event === "push" && list("tags")) return { ok: false, reason: "on: push только для тегов" };
  }
  const paths = list("paths"), pIgn = list("paths-ignore");
  if (paths) {
    const m = anyChange(paths, c.changes);
    if (m !== true) return { ok: m, reason: m === false ? `изменения не подходят под paths: ${paths.join(", ")}` : "нужен список изменённых файлов" };
  }
  if (pIgn && c.changes) {
    const all = c.changes.every((f) => pIgn.some((p) => globMatch(p, f)));
    if (all && c.changes.length) return { ok: false, reason: "все изменения под paths-ignore" };
  }
  return { ok: true, reason: `on: ${want}` };
}

/** What would run for this context. Jobs are returned in the same order as in the pipeline. */
export function plan(p: Pipeline, c: RunCtx): Planned[] {
  if (p.kind === "github") {
    const t = githubTriggered(p.workflow, c);
    return p.jobs.map((job) => {
      if (t.ok !== true) return { job, status: (t.ok === "unknown" ? "unknown" : "skip") as Status, reason: t.reason };
      if (!job.rules?.length) return { job, status: "run" as Status, reason: t.reason };
      const v = evalGithubIf(String(job.rules[0].if), c);
      return { job, status: (v === true ? "run" : v === false ? "skip" : "unknown") as Status, reason: `if: ${String(job.rules[0].if)}` };
    });
  }
  const vars = gitlabVars(c);
  // workflow:rules decide whether the pipeline is created at all
  if (isObj(p.workflow) && Array.isArray(p.workflow.rules)) {
    const w = planRules(p.workflow.rules, c, vars, "always");
    if (w.status === "skip") return p.jobs.map((job) => ({ job, status: "skip" as Status, reason: `пайплайн не создаётся: workflow ${w.reason}` }));
    if (w.status === "unknown") return p.jobs.map((job) => ({ job, status: "unknown" as Status, reason: `workflow ${w.reason}` }));
  }
  return p.jobs.map((job) => {
    if (job.rules) return { job, ...planRules(job.rules, c, vars, job.when) };
    if (job.except !== undefined && onlyExcept(job.except, c, vars) === true) return { job, status: "skip" as Status, reason: "except" };
    if (job.only !== undefined) {
      const v = onlyExcept(job.only, c, vars);
      if (v === false) return { job, status: "skip" as Status, reason: `only: ${JSON.stringify(job.only)}` };
      if (v === "unknown") return { job, status: "unknown" as Status, reason: `only: ${JSON.stringify(job.only)}` };
    }
    return { job, status: statusOfWhen(job.when), reason: job.when === "manual" ? "when: manual" : "" };
  });
}

/**
 * Variables the conditions ask about that neither GitLab nor the user has set here: project, group and
 * schedule variables live outside the file. GitLab compares an unset variable as empty, so the plan is
 * right for "not set" — but these are exactly the ones worth typing in by hand.
 */
export function missingVars(p: Pipeline, c: RunCtx): string[] {
  const known = new Set(Object.keys(p.kind === "gitlab" ? gitlabVars(c) : (c.vars ?? {})));
  const out = new Set<string>();
  const scan = (rules: any[] | undefined) => {
    for (const r of rules ?? []) {
      const cond = isObj(r) ? r.if : undefined;
      for (const m of String(cond ?? "").matchAll(/\$\{?(\w+)\}?/g)) if (!known.has(m[1])) out.add(m[1]);
    }
  };
  if (isObj(p.workflow) && Array.isArray(p.workflow.rules)) scan(p.workflow.rules);
  for (const j of p.jobs) scan(j.rules);
  // CI_* belong to GitLab itself; what is left are the project, group and schedule variables
  return [...out].filter((n) => !n.startsWith("CI_") && n !== "GITLAB_CI").sort();
}

/** What is different between two contexts (two branches, push and merge request…). */
export function diffPlans(a: Planned[], b: Planned[]): { name: string; from: Status; to: Status }[] {
  const byName = new Map(a.map((x) => [x.job.name, x.status]));
  const out: { name: string; from: Status; to: Status }[] = [];
  for (const p of b) {
    const from = byName.get(p.job.name);
    if (from !== undefined && from !== p.status) out.push({ name: p.job.name, from, to: p.status });
  }
  return out;
}
