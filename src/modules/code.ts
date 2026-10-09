import { relTo } from "./paths";
import { eolOf, toLf, withEol, type Eol } from "./eol";
import { locale } from "../i18n";
import { helpBtn } from "./help";
import { icon } from "./icons";
import { invoke } from "@tauri-apps/api/core";
import { ask, esc, popupMenu, toast } from "./ui";
import { registerProvider } from "./palette";
import { terminalApi } from "./terminal";
import { hcl, hclBalance } from "./hcl";
import { PtyTerminal } from "./pty";
import { cdCommand } from "./shellkind";
import { diffContext, fileContext, projectContext } from "./aictx";
import { attachPathLinks } from "./files";
import { fileIcon, folderIcon } from "./fileicons";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { openSearchPanel } from "@codemirror/search";
import { StreamLanguage, indentUnit } from "@codemirror/language";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { indentWithTab } from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { sql } from "@codemirror/lang-sql";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { parseAllDocuments } from "yaml";
import { natCmp } from "./natsort";

type Entry = { name: string; dir: boolean; link: boolean; size: number };
type Git = { root: string; branch: string; files: Record<string, string>; error?: string };
type Commit = { hash: string; parents: string[]; refs: string[]; author: string; time: number; subject: string };
type Branch = { name: string; upstream: string; track: string; time: number; subject: string };
type Branches = { current: string; local: Branch[]; remote: Branch[] };
type FmtResult = { text: string | null; errors: { line: number; message: string }[]; tool: string };

type Tab = {
  /** absolute path, or "git:<hash>" / "diff:<file>" for read-only views */
  id: string;
  title: string;
  path: string | null;
  state: EditorState;
  saved: string;
  /** the file's line endings: the editor works in "\n", saving writes these back */
  eol: Eol;
  mtime: number;
  readonly: boolean;
  btn: HTMLElement;
};

const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
const join = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);
const isTf = (p: string | null) => !!p && /\.(tf|tfvars|hcl)$/i.test(p);
const ago = (t: number) => {
  const d = Date.now() / 1000 - t;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))} мин` : d < 86400 ? `${Math.round(d / 3600)} ч` : d < 86400 * 60 ? `${Math.round(d / 86400)} дн` : new Date(t * 1000).toLocaleDateString(locale());
};

function languageFor(path: string): { ext: Extension; name: string } {
  const name = base(path).toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  const legacy = (p: Parameters<typeof StreamLanguage.define>[0], n: string) => ({ ext: StreamLanguage.define(p), name: n });
  if (name === "dockerfile" || name.endsWith(".dockerfile") || name.startsWith("dockerfile.")) return legacy(dockerFile, "Dockerfile");
  if (["makefile", ".bashrc", ".zshrc", ".profile", ".bash_profile"].includes(name)) return legacy(shell, "Shell");
  switch (ext) {
    case "ts": case "mts": case "cts": return { ext: javascript({ typescript: true }), name: "TypeScript" };
    case "tsx": return { ext: javascript({ typescript: true, jsx: true }), name: "TSX" };
    case "js": case "mjs": case "cjs": return { ext: javascript(), name: "JavaScript" };
    case "jsx": return { ext: javascript({ jsx: true }), name: "JSX" };
    case "json": case "jsonc": case "json5": return { ext: json(), name: "JSON" };
    case "yaml": case "yml": return { ext: yaml(), name: "YAML" };
    case "md": case "markdown": return { ext: markdown(), name: "Markdown" };
    case "py": return { ext: python(), name: "Python" };
    case "rs": return { ext: rust(), name: "Rust" };
    case "go": return { ext: go(), name: "Go" };
    case "sql": return { ext: sql(), name: "SQL" };
    case "html": case "htm": case "vue": case "svelte": return { ext: html(), name: "HTML" };
    case "css": case "scss": case "less": return { ext: css(), name: "CSS" };
    case "tf": case "tfvars": case "hcl": case "nomad": return { ext: hcl(), name: "Terraform" };
    case "sh": case "bash": case "zsh": case "env": return legacy(shell, "Shell");
    case "toml": return legacy(toml, "TOML");
    case "diff": case "patch": return legacy(diff, "Diff");
    case "ini": case "conf": case "cfg": case "properties": return name.includes("nginx") ? legacy(nginx, "Nginx") : legacy(properties, "INI");
    default: return { ext: [], name: "Текст" };
  }
}

/** YAML: syntax errors and warnings for every document in the file. */
function yamlLint(view: EditorView): Diagnostic[] {
  const text = view.state.doc.toString();
  const out: Diagnostic[] = [];
  try {
    for (const doc of parseAllDocuments(text, { prettyErrors: false })) {
      const list = [...doc.errors.map((e) => ({ e, sev: "error" as const })), ...doc.warnings.map((e) => ({ e, sev: "warning" as const }))];
      for (const { e, sev } of list) {
        const from = Math.min(e.pos[0], text.length), to = Math.min(Math.max(e.pos[1], e.pos[0] + 1), text.length);
        out.push({ from, to: Math.max(from, to), severity: sev, message: e.message.split("\n")[0] });
      }
    }
  } catch (e) {
    out.push({ from: 0, to: 0, severity: "error", message: String(e) });
  }
  return out;
}

const lineRange = (view: EditorView, line: number) => {
  const l = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
  return { from: l.from, to: l.to };
};

export function mountCode(root: HTMLElement) {
  root.classList.add("code-view");
  root.innerHTML = `
    <aside class="code-side">
      <div class="side-head"><span class="code-proj" title="">Проект не открыт</span>
        <span class="row">
          <button class="icon" data-a="open" title="Выбрать папку проекта (весь проект откроется деревом слева)">${icon("folderOpen", 16)}</button>
          <button class="icon" data-a="from-term" title="Открыть папку, в которой сейчас терминал">⌁</button>
          <button class="icon" data-a="new-file" title="Новый файл в проекте">${icon("plus", 16)}</button>
          <button class="icon" data-a="refresh" title="Обновить">${icon("refresh", 16)}</button>
          ${helpBtn("code")}
        </span></div>
      <select class="code-recent" title="Недавние проекты"><option value="">Недавние проекты…</option></select>
      <div class="code-tree"></div>
    </aside>
    <div class="code-split" data-split="side" title="Потяните, чтобы изменить ширину"></div>
    <div class="code-main">
      <div class="code-tabs"></div>
      <div class="code-editor"></div>
      <div class="code-empty muted">Откройте папку проекта и выберите файл слева. ${"Ctrl+S"} — сохранить, ${"Ctrl+Shift+F"} — terraform fmt.</div>
      <div class="code-hsplit" hidden title="Потяните, чтобы изменить высоту консоли"></div>
      <div class="code-console" hidden>
        <div class="cc-head"><span class="cc-cwd muted"></span><span class="spacer"></span>
          <button class="icon" data-a="cc-restart" title="Перезапустить shell">${icon("refresh", 16)}</button>
          <button class="icon" data-a="cc-tab" title="Открыть эту папку во вкладке терминала">⧉</button>
          <button class="icon" data-a="console" title="Скрыть (Ctrl+\`)">${icon("close", 16)}</button></div>
        <div class="cc-host"></div>
      </div>
      <div class="code-status">
        <span class="cs-lang"></span><span class="cs-pos"></span><span class="cs-diag"></span>
        <span class="spacer"></span>
        <span class="cs-tf muted"></span>
        <button class="ghost" data-a="fmt" hidden title="terraform fmt (Ctrl+Shift+F); при сохранении выполняется сам">fmt</button>
        <button class="ghost" data-a="ai" title="Спросить ИИ о файле, проекте или изменениях: контекст уйдёт в AI-панель (локальный ИИ или выбранный агент)">⇢ AI ▾</button>
        <button class="ghost" data-a="console" title="Консоль в папке проекта (Ctrl+\`)">▭ консоль</button>
        <button class="ghost" data-a="git-toggle" title="Показать/скрыть панель git">⎇ git</button>
      </div>
    </div>
    <div class="code-split" data-split="git" hidden title="Потяните, чтобы изменить ширину"></div>
    <aside class="code-git" hidden>
      <div class="side-head cg-head">
        <button class="ghost cg-branch-btn" data-a="branches" title="Ветки: переключить, создать, слить, удалить">⎇ <span class="cg-branch">git</span> ▾</button>
        <span class="row">
          <button class="icon" data-a="git-fetch" title="Получить изменения со всех remote (fetch --all --prune)">⟳</button>
          <button class="icon" data-a="git-pull" title="Подтянуть текущую ветку (pull --ff-only)">↓</button>
          <button class="icon" data-a="git-push" title="Отправить текущую ветку (push; новая ветка — с -u origin)">↑</button>
          <button class="icon" data-a="git-refresh" title="Обновить">${icon("refresh", 16)}</button>
        </span></div>
      <div class="cg-branches" hidden></div>
      <div class="side-head small">Изменения</div>
      <div class="cg-changes"></div>
      <div class="cg-commit-box">
        <textarea class="cg-msg-in" rows="2" spellcheck="false" placeholder="Сообщение коммита… Ctrl+Enter — закоммитить всё"></textarea>
        <button data-a="git-commit" title="git add -A и commit">Закоммитить всё</button>
      </div>
      <div class="side-head small">История</div>
      <div class="cg-graph"></div>
    </aside>`;

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const treeEl = $(".code-tree"), tabsEl = $(".code-tabs"), host = $(".code-editor"), empty = $(".code-empty");
  const gitPanel = $(".code-git"), recentSel = $<HTMLSelectElement>(".code-recent");

  let project = ls.get("opsdeck.code.root") ?? "";
  let git: Git = { root: "", branch: "", files: {} };
  const expanded = new Set<string>(JSON.parse(ls.get("opsdeck.code.expanded") ?? "[]") as string[]);
  const listing = new Map<string, Entry[] | string>();
  const tabs: Tab[] = [];
  let active: Tab | null = null;
  let tfTool: string | null = null; // null = not checked yet, "" = not installed
  let tfErrors: { line: number; message: string }[] = [];

  // ----- editor -----
  const langC = new Compartment(), lintC = new Compartment(), roC = new Compartment();
  const view = new EditorView({ parent: host });
  view.dom.style.height = "100%";

  const tfLinter = linter(async (v) => {
    if (!isTf(active?.path ?? null)) return [];
    const text = v.state.doc.toString();
    if (tfTool === null) tfTool = (await invoke<FmtResult>("code_tf_fmt", { text: "" }).catch(() => null))?.tool ?? "";
    let errs: { line: number; message: string }[];
    if (tfTool) {
      const r = await invoke<FmtResult>("code_tf_fmt", { text }).catch(() => null);
      errs = r?.errors ?? [];
    } else {
      errs = hclBalance(text);
    }
    tfErrors = errs;
    syncStatus();
    return errs.map((e) => ({ ...lineRange(v, e.line), severity: "error" as const, message: e.message, source: tfTool || "проверка скобок" }));
  }, { delay: 700 });

  function extensionsFor(t: { path: string | null; readonly: boolean; lang: Extension }): Extension[] {
    const lint: Extension[] = [];
    const p = t.path ?? "";
    if (/\.ya?ml$/i.test(p)) lint.push(linter(yamlLint, { delay: 400 }), lintGutter());
    else if (/\.json$/i.test(p)) lint.push(linter(jsonParseLinter(), { delay: 400 }), lintGutter());
    else if (isTf(p)) lint.push(tfLinter, lintGutter());
    return [
      basicSetup,
      oneDark,
      indentUnit.of("  "),
      keymap.of([indentWithTab]),
      // by physical key (event.code): CodeMirror's own bindings go by the typed letter, so Ctrl+S / Ctrl+F
      // did nothing on the Russian layout
      Prec.highest(EditorView.domEventHandlers({
        keydown(e, v) {
          if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
          if (e.code === "KeyS" && !e.shiftKey) save();
          else if (e.code === "KeyF" && e.shiftKey) fmt();
          else if (e.code === "KeyF") openSearchPanel(v);
          else return false;
          e.preventDefault();
          return true;
        },
      })),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && active) markDirty(active);
        if (u.selectionSet || u.docChanged) syncPos();
      }),
      langC.of(t.lang),
      lintC.of(lint),
      roC.of(EditorState.readOnly.of(t.readonly)),
      EditorView.theme({ "&": { height: "100%", fontSize: "13px" }, ".cm-scroller": { fontFamily: "'JetBrains Mono', 'Fira Code', monospace" } }),
    ];
  }

  const isDirty = (t: Tab) => !t.readonly && (t === active ? view.state : t.state).doc.toString() !== t.saved;
  function markDirty(t: Tab) {
    t.btn.classList.toggle("dirty", isDirty(t));
  }
  function syncPos() {
    const s = view.state, head = s.selection.main.head, line = s.doc.lineAt(head);
    $(".cs-pos").textContent = active ? `стр ${line.number}, кол ${head - line.from + 1}` : "";
  }
  function syncStatus() {
    const t = active;
    $(".cs-lang").textContent = t?.path ? languageFor(t.path).name : t ? "только чтение" : "";
    const tf = isTf(t?.path ?? null);
    $<HTMLButtonElement>("[data-a=fmt]").hidden = !tf || !tfTool;
    $(".cs-tf").textContent = !tf ? "" : tfTool === "" ? "terraform не найден: только проверка скобок, fmt недоступен" : tfErrors.length ? `${tfTool}: ошибок ${tfErrors.length}` : tfTool ? `${tfTool} fmt ✓` : "";
    $(".cs-diag").textContent = "";
  }

  // ----- tabs -----
  function activate(t: Tab | null) {
    if (active && active !== t) active.state = view.state;
    active = t;
    tabs.forEach((x) => x.btn.classList.toggle("active", x === t));
    empty.hidden = !!t;
    host.hidden = !t;
    if (t) {
      view.setState(t.state);
      t.btn.scrollIntoView({ block: "nearest", inline: "nearest" });
      requestAnimationFrame(() => view.focus());
      if (t.path) revealInTree(t.path);
    }
    tfErrors = [];
    syncStatus();
    syncPos();
    ls.set("opsdeck.code.tabs", JSON.stringify(tabs.filter((x) => x.path).map((x) => x.path)));
    ls.set("opsdeck.code.active", t?.path ?? "");
  }

  function addTab(id: string, title: string, path: string | null, text: string, mtime: number, readonly: boolean, langOverride?: Extension): Tab {
    const btn = document.createElement("div");
    btn.className = "tab code-tab";
    btn.innerHTML = `<span class="ct-ico">${path ? fileIcon(path) : ""}</span><span class="label"></span><span class="dot">●</span><span class="x" title="Закрыть">×</span>`;
    btn.querySelector(".label")!.textContent = title;
    btn.title = path ?? title;
    tabsEl.appendChild(btn);
    const lang = langOverride ?? (path ? languageFor(path).ext : []);
    const t: Tab = { id, title, path, saved: toLf(text), eol: eolOf(text), mtime, readonly, btn, state: EditorState.create({ doc: toLf(text), extensions: extensionsFor({ path, readonly, lang }) }) };
    btn.onclick = () => activate(t);
    btn.onauxclick = (e) => { if (e.button === 1) closeTab(t); };
    btn.querySelector<HTMLElement>(".x")!.onclick = (e) => { e.stopPropagation(); closeTab(t); };
    tabs.push(t);
    return t;
  }

  async function closeTab(t: Tab) {
    if (t === active) t.state = view.state;
    if (isDirty(t) && (await ask("Несохранённые изменения", `Изменения в «${t.title}» будут потеряны. Закрыть?`, { ok: "Закрыть без сохранения", danger: true })) === null) return;
    const i = tabs.indexOf(t);
    tabs.splice(i, 1);
    t.btn.remove();
    if (active === t) { active = null; activate(tabs[i] ?? tabs[i - 1] ?? null); } else activate(active);
  }

  /** Open a file (optionally jump to a line). */
  async function openFile(path: string, line?: number) {
    let t = tabs.find((x) => x.id === path);
    if (!t) {
      try {
        const r = await invoke<{ text: string; mtime: number }>("code_read", { path });
        t = addTab(path, base(path), path, r.text, r.mtime, false);
      } catch (e) { toast(String(e), "err"); return; }
    }
    activate(t);
    if (line) {
      const l = view.state.doc.line(Math.min(line, view.state.doc.lines));
      view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
    }
  }

  function openReadonly(id: string, title: string, text: string) {
    const old = tabs.find((x) => x.id === id);
    if (old) { activate(old); return; }
    activate(addTab(id, title, null, text, 0, true, StreamLanguage.define(diff)));
  }

  // ----- save / fmt -----
  async function fmt(): Promise<boolean> {
    const t = active;
    if (!t?.path || !isTf(t.path)) return true;
    const text = view.state.doc.toString();
    const r = await invoke<FmtResult>("code_tf_fmt", { text }).catch((e) => { toast(String(e), "err"); return null; });
    if (!r) return false;
    tfTool = r.tool;
    tfErrors = r.errors;
    syncStatus();
    if (!r.tool) { toast("terraform (или tofu) не найден в PATH — fmt недоступен", "err"); return true; }
    if (r.text === null) { toast(`terraform fmt: ${r.errors[0]?.message ?? "ошибка синтаксиса"} (стр ${r.errors[0]?.line ?? "?"})`, "err"); return false; }
    if (r.text !== text) {
      // keep the cursor on the same line
      const line = view.state.doc.lineAt(view.state.selection.main.head).number;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: r.text } });
      const l = view.state.doc.line(Math.min(line, view.state.doc.lines));
      view.dispatch({ selection: { anchor: l.from } });
    }
    return true;
  }

  async function save(force = false) {
    const t = active;
    if (!t?.path || t.readonly) return;
    if (isTf(t.path) && tfTool !== "") await fmt(); // format on save; a syntax error still saves as is
    const text = view.state.doc.toString();
    try {
      t.mtime = await invoke<number>("code_write", { path: t.path, text: withEol(text, t.eol), expectMtime: t.mtime || null, force });
      t.saved = text;
      markDirty(t);
      toast(`Сохранено: ${t.title}`);
      refreshGit();
    } catch (e) {
      if (String(e).startsWith("CONFLICT")) {
        const choice = await ask("Файл изменён на диске", `«${t.title}» поменялся снаружи после открытия. Перезаписать своей версией?`, { ok: "Перезаписать", danger: true });
        if (choice !== null) save(true);
      } else toast(String(e), "err");
    }
  }

  // ----- project tree -----
  async function readDir(dir: string) {
    listing.set(dir, await invoke<Entry[]>("fs_list", { path: dir, hidden: true }).catch((e) => String(e)));
  }
  const relToGit = (abs: string) => { const r = relTo(git.root, abs); return r ? r : null; };
  const HIDE = new Set([".git", "node_modules", "target", ".terraform", "dist", "__pycache__", ".venv", ".idea", ".vscode"]);

  function statusOf(abs: string, dir: boolean): string {
    const rel = relToGit(abs);
    if (rel === null) return "";
    if (!dir) return git.files[rel] ?? "";
    return Object.keys(git.files).some((f) => f.startsWith(rel + "/")) ? "M" : "";
  }
  const stClass = (code: string) => (code.includes("?") ? "new" : code.includes("A") ? "added" : code.includes("D") ? "del" : code.trim() ? "mod" : "");

  function renderDir(dir: string, depth: number): string {
    const l = listing.get(dir);
    if (l === undefined) return `<div class="ct-row muted" style="--depth:${depth}">…</div>`;
    if (typeof l === "string") return `<div class="ct-row err" style="--depth:${depth}">${esc(l)}</div>`;
    return l.filter((e) => !(e.dir && HIDE.has(e.name))).map((e) => {
      const abs = join(dir, e.name);
      const st = stClass(statusOf(abs, e.dir));
      if (e.dir) {
        const open = expanded.has(abs);
        return `<div class="ct-dir ${open ? "open" : ""}" data-p="${esc(abs)}">
          <div class="ct-row ${st}" style="--depth:${depth}"><span class="tree-caret">▸</span><span class="ct-ico ct-ico-closed">${folderIcon(e.name)}</span><span class="ct-ico ct-ico-open">${folderIcon(e.name, true)}</span><span class="tree-label">${esc(e.name)}</span></div>
          <div class="ct-kids">${open ? renderDir(abs, depth + 1) : ""}</div></div>`;
      }
      return `<div class="ct-row ct-file ${st} ${active?.path === abs ? "active" : ""}" data-f="${esc(abs)}" style="--depth:${depth}" title="${esc(abs)}">
        <span class="ct-ico">${fileIcon(e.name)}</span><span class="tree-label">${esc(e.name)}</span>${st ? `<span class="ct-st">${esc(statusOf(abs, false).trim() || "M")}</span>` : ""}</div>`;
    }).join("") || `<div class="ct-row muted" style="--depth:${depth}">пусто</div>`;
  }

  function drawTree() {
    if (!project) { treeEl.innerHTML = `<p class="muted pad">Нажмите 📂 и укажите папку проекта, или ⌁ — взять папку из терминала.</p>`; return; }
    treeEl.innerHTML = renderDir(project, 0);
  }

  async function loadTree() {
    if (!project) return drawTree();
    $(".code-proj").textContent = base(project);
    $(".code-proj").title = project;
    await Promise.all([readDir(project), ...[...expanded].filter((d) => d.startsWith(project)).map(readDir)]);
    await refreshGit(false);
    drawTree();
  }

  function revealInTree(path: string) {
    treeEl.querySelectorAll(".ct-file.active").forEach((x) => x.classList.remove("active"));
    treeEl.querySelector(`.ct-file[data-f="${CSS.escape(path)}"]`)?.classList.add("active");
  }

  treeEl.addEventListener("click", async (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".ct-row");
    if (!row) return;
    const file = row.dataset.f;
    if (file) return openFile(file);
    const dir = row.parentElement as HTMLElement;
    const p = dir.dataset.p;
    if (!p) return;
    if (dir.classList.toggle("open")) {
      expanded.add(p);
      if (!listing.has(p)) await readDir(p);
      dir.querySelector<HTMLElement>(":scope > .ct-kids")!.innerHTML = renderDir(p, Number(getComputedStyle(row).getPropertyValue("--depth")) + 1);
    } else expanded.delete(p);
    ls.set("opsdeck.code.expanded", JSON.stringify([...expanded]));
  });

  async function setProject(dir: string) {
    if (!dir) return;
    project = dir.replace(/\/+$/, "") || "/";
    ls.set("opsdeck.code.root", project);
    const recent = [project, ...((JSON.parse(ls.get("opsdeck.code.recent") ?? "[]") as string[]).filter((x) => x !== project))].slice(0, 12);
    ls.set("opsdeck.code.recent", JSON.stringify(recent));
    fillRecent();
    listing.clear();
    await loadTree();
    if (!gitPanel.hidden) drawGit();
    followConsole();
  }
  function fillRecent() {
    const recent = JSON.parse(ls.get("opsdeck.code.recent") ?? "[]") as string[];
    recentSel.innerHTML = `<option value="">Недавние проекты…</option>` + recent.map((r) => `<option value="${esc(r)}">${esc(base(r))} — ${esc(r)}</option>`).join("");
  }
  recentSel.onchange = () => { if (recentSel.value) setProject(recentSel.value); recentSel.value = ""; };

  $("[data-a=open]").onclick = async () => {
    // native folder picker; typing a path stays available if the dialog can't open
    const picked = await invoke<string | null>("pick_folder", { start: project || null }).catch(() => undefined);
    if (picked) return setProject(picked);
    if (picked === null) return; // cancelled
    const dir = await ask("Открыть проект", "Папка проекта:", { input: project || "~/", ok: "Открыть" });
    if (dir) setProject(dir.trim());
  };
  $("[data-a=from-term]").onclick = () => {
    const cwd = terminalApi.active?.blocks.cwd;
    if (cwd) setProject(cwd); else toast("Не знаю папку терминала: нужна вкладка с bash/zsh из OpsDeck", "err");
  };
  $("[data-a=refresh]").onclick = () => { listing.clear(); loadTree(); };
  async function newEntry(dir: string) {
    if (!project) return toast("Сначала откройте проект", "err");
    const name = await ask("Новый файл", `Путь внутри «${base(dir)}» (папки через /; на конце / — создать папку):`, { input: "", ok: "Создать" });
    if (!name?.trim()) return;
    const rel = name.trim().replace(/^\/+/, "");
    const abs = join(dir, rel.replace(/\/+$/, ""));
    try {
      await invoke("code_create", { path: abs, dir: rel.endsWith("/") });
      expanded.add(dir);
      listing.clear();
      await loadTree();
      if (!rel.endsWith("/")) openFile(abs);
    } catch (e) { toast(String(e), "err"); }
  }
  $("[data-a=new-file]").onclick = () => newEntry(project);

  // ----- context menu on the tree: new / rename / copy, paste / delete -----
  let clip: { path: string } | null = null;
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
  const within = (p: string, parent: string) => p === parent || p.startsWith(parent + "/");

  /** `name`, or "name копия.ext", "name копия 2.ext" … when that name is taken in `dir`. */
  async function freeName(dir: string, name: string): Promise<string> {
    await readDir(dir);
    const l = listing.get(dir);
    const taken = new Set(typeof l === "string" || !l ? [] : l.map((e) => e.name));
    if (!taken.has(name)) return name;
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let n = 1; ; n++) {
      const c = `${stem} копия${n > 1 ? " " + n : ""}${ext}`;
      if (!taken.has(c)) return c;
    }
  }

  /** Open tabs follow a renamed file or folder. */
  function retarget(from: string, to: string) {
    for (const t of tabs) {
      if (!t.path || !within(t.path, from)) continue;
      t.path = t.id = to + t.path.slice(from.length);
      t.title = base(t.path);
      t.btn.querySelector(".label")!.textContent = t.title;
      t.btn.title = t.path;
    }
    for (const d of [...expanded]) if (within(d, from)) { expanded.delete(d); expanded.add(to + d.slice(from.length)); }
    ls.set("opsdeck.code.expanded", JSON.stringify([...expanded]));
    activate(active);
  }

  async function renameEntry(path: string) {
    const old = base(path);
    const name = (await ask("Переименовать", `Новое имя для «${old}»:`, { input: old, ok: "Переименовать" }))?.trim();
    if (!name || name === old) return;
    if (/[\\/]/.test(name) || name === "." || name === "..") return toast("В имени не должно быть / и \\", "err");
    const to = join(dirOf(path), name);
    try {
      await invoke("code_rename", { root: project, from: path, to });
      retarget(path, to);
      listing.clear();
      await loadTree();
    } catch (e) { toast(String(e), "err"); }
  }

  async function pasteInto(dir: string) {
    if (!clip) return;
    try {
      const to = join(dir, await freeName(dir, base(clip.path)));
      await invoke("code_copy", { root: project, from: clip.path, to });
      expanded.add(dir);
      listing.clear();
      await loadTree();
      toast(`Скопировано: ${base(to)}`);
    } catch (e) { toast(String(e), "err"); }
  }

  async function deleteEntry(path: string, isDir: boolean) {
    const unsaved = tabs.filter((t) => t.path && within(t.path, path) && isDirty(t)).length;
    const msg = `Удалить ${isDir ? "папку" : "файл"} «${base(path)}»${isDir ? " со всем содержимым" : ""}? Корзины нет — вернуть можно только из git.${unsaved ? ` Несохранённых вкладок: ${unsaved}.` : ""}`;
    if ((await ask(isDir ? "Удалить папку" : "Удалить файл", msg, { ok: "Удалить", danger: true })) === null) return;
    try {
      await invoke("code_delete", { root: project, path });
      for (const t of tabs.filter((x) => x.path && within(x.path, path))) {
        const i = tabs.indexOf(t);
        tabs.splice(i, 1);
        t.btn.remove();
        if (active === t) active = null;
      }
      if (clip && within(clip.path, path)) clip = null;
      if (!active) activate(tabs[tabs.length - 1] ?? null); else activate(active);
      listing.clear();
      await loadTree();
    } catch (e) { toast(String(e), "err"); }
  }

  treeEl.addEventListener("contextmenu", (e) => {
    if (!project) return;
    e.preventDefault();
    const row = (e.target as HTMLElement).closest<HTMLElement>(".ct-row");
    const file = row?.dataset.f ?? null;
    const dirPath = row && !file ? row.parentElement?.dataset.p ?? null : null;
    const target = file ?? dirPath;
    const into = dirPath ?? (file ? dirOf(file) : project);
    const items: [string, () => void, boolean?][] = [];
    if (file) items.push(["Открыть", () => openFile(file)]);
    items.push(["＋ Новый файл или папка…", () => newEntry(into)]);
    if (target) {
      items.push(["Переименовать…", () => renameEntry(target)]);
      items.push(["Копировать", () => { clip = { path: target }; toast(`Скопировано: ${base(target)} — «Вставить» в нужной папке`); }]);
    }
    if (clip) items.push([`Вставить «${base(clip.path)}»`, () => pasteInto(into)]);
    if (target) items.push([file ? "Удалить файл" : "Удалить папку", () => deleteEntry(target, !file), true]);
    popupMenu({ left: e.clientX, top: e.clientY, bottom: e.clientY }, items);
  });
  $("[data-a=fmt]").onclick = () => fmt();

  // ----- ask the AI about the file / project / changes: the context goes to the AI panel -----
  async function askAi(kind: "file" | "project" | "diff") {
    if (!project) return toast("Сначала откройте проект", "err");
    let detail = "";
    if (kind === "file") {
      if (!active) return toast("Откройте файл", "err");
      const st = view.state, sel = st.selection.main, name = active.path ?? active.title;
      detail = sel.empty
        ? fileContext(name, st.doc.toString(), null)
        : fileContext(name, st.sliceDoc(sel.from, sel.to), { from: st.doc.lineAt(sel.from).number, to: st.doc.lineAt(sel.to).number });
    } else if (kind === "project") {
      const names = async (dir: string) => {
        const l = await invoke<Entry[]>("fs_list", { path: dir, hidden: true }).catch(() => [] as Entry[]);
        return l.filter((e) => !(e.dir && HIDE.has(e.name))).map((e) => (e.dir ? `${e.name}/` : e.name));
      };
      const top = await names(project);
      const tree: Record<string, string[]> = { "": top };
      await Promise.all(top.filter((n) => n.endsWith("/")).slice(0, 12).map(async (n) => { tree[n.slice(0, -1)] = await names(join(project, n.slice(0, -1))); }));
      await refreshGit(false);
      detail = projectContext({ name: base(project), path: project, branch: git.branch, tree, changes: git.files });
    } else {
      await refreshGit(false);
      const files = Object.keys(git.files);
      if (!git.root || !files.length) return toast("Нет незакоммиченных изменений", "err");
      const diffs = await Promise.all(files.slice(0, 5).map(async (file) => ({ file, diff: await invoke<string>("code_git_diff", { root: git.root, file }).catch((x) => String(x)) })));
      detail = diffContext(project, diffs, files.length);
    }
    window.dispatchEvent(new CustomEvent("send-to-ai", { detail }));
  }
  $("[data-a=ai]").onclick = (e) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    popupMenu({ left: r.left, top: r.top, bottom: r.bottom }, [
      ["О файле (или выделенном фрагменте)", () => askAi("file")],
      ["О проекте: структура и git status", () => askAi("project")],
      ["Проверить изменения (git diff)", () => askAi("diff")],
    ]);
  };

  // ----- git panel -----
  async function refreshGit(redraw = true) {
    if (!project) return;
    git = await invoke<Git>("fs_git_status", { path: project }).catch(() => ({ root: "", branch: "", files: {} }));
    if (redraw) drawTree();
    if (!gitPanel.hidden) drawChanges();
  }

  function drawChanges() {
    $(".cg-branch").textContent = git.root ? git.branch || "detached" : git.error ? "git недоступен" : "не git-репозиторий";
    $(".cg-branch").closest<HTMLElement>("button")!.title = git.error || "Ветки: переключить, создать, слить, удалить";
    $(".cg-commit-box").hidden = !git.root || !Object.keys(git.files).length;
    const files = Object.entries(git.files).sort(([a], [b]) => natCmp(a, b));
    $(".cg-changes").innerHTML = !git.root ? (git.error ? `<p class="err pad">${esc(git.error)}</p>` : "") : files.length
      ? files.map(([f, code]) => `<div class="cg-file ${stClass(code)}" data-file="${esc(f)}" title="${esc(f)} — показать изменения">
          <span class="ct-st">${esc(code.trim() || "M")}</span><span class="ct-ico">${fileIcon(f)}</span><span class="tree-label">${esc(base(f))}</span><span class="cg-dir muted">${esc(f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "")}</span></div>`).join("")
      : `<p class="muted pad">чисто ✓</p>`;
  }

  const LANE_COLORS = ["#61afef", "#98d982", "#e6c07b", "#c678dd", "#56b6c2", "#ef5f6b", "#d19a66", "#7fdbca"];
  async function drawGraph() {
    const box = $(".cg-graph");
    if (!git.root) { box.innerHTML = ""; return; }
    box.innerHTML = `<p class="muted pad">загрузка…</p>`;
    const commits = await invoke<Commit[]>("code_git_log", { path: git.root, limit: 300 }).catch((e) => { box.innerHTML = `<p class="err pad">${esc(e)}</p>`; return null; });
    if (!commits) return;
    // lanes: which commit each column is waiting for
    let lanes: (string | null)[] = [];
    const W = 12, H = 26, R = 4;
    const x = (i: number) => 8 + i * W;
    const rows: string[] = [];
    for (const c of commits) {
      let col = lanes.indexOf(c.hash);
      if (col === -1) { col = lanes.indexOf(null); if (col === -1) col = lanes.length; lanes[col] = c.hash; }
      const before = [...lanes];
      // other lanes that also waited for this commit end here (branch merged into it)
      const joining = before.map((h, i) => (h === c.hash && i !== col ? i : -1)).filter((i) => i >= 0);
      joining.forEach((i) => (lanes[i] = null));
      lanes[col] = c.parents[0] ?? null;
      const parentCols: number[] = [];
      c.parents.forEach((p, k) => {
        if (k === 0) { parentCols.push(col); return; }
        let i = lanes.indexOf(p);
        if (i === -1) { i = lanes.indexOf(null); if (i === -1) i = lanes.length; lanes[i] = p; }
        parentCols.push(i);
      });
      while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
      const width = Math.max(before.length, lanes.length, col + 1);
      const color = (i: number) => LANE_COLORS[i % LANE_COLORS.length];
      let svg = "";
      // pass-through lines
      before.forEach((h, i) => {
        if (h && h !== c.hash && i !== col) svg += `<line x1="${x(i)}" y1="0" x2="${x(i)}" y2="${H}" stroke="${color(i)}" stroke-width="2"/>`;
      });
      // incoming line to the dot (from above), and merges into it
      if (before[col] === c.hash) svg += `<line x1="${x(col)}" y1="0" x2="${x(col)}" y2="${H / 2}" stroke="${color(col)}" stroke-width="2"/>`;
      joining.forEach((i) => (svg += `<path d="M${x(i)} 0 C ${x(i)} ${H / 2}, ${x(col)} ${H / 4}, ${x(col)} ${H / 2}" stroke="${color(i)}" stroke-width="2" fill="none"/>`));
      // outgoing lines to parents
      parentCols.forEach((i) => {
        svg += i === col
          ? `<line x1="${x(col)}" y1="${H / 2}" x2="${x(col)}" y2="${H}" stroke="${color(col)}" stroke-width="2"/>`
          : `<path d="M${x(col)} ${H / 2} C ${x(col)} ${H * 0.8}, ${x(i)} ${H * 0.7}, ${x(i)} ${H}" stroke="${color(i)}" stroke-width="2" fill="none"/>`;
      });
      const merge = c.parents.length > 1;
      svg += `<circle cx="${x(col)}" cy="${H / 2}" r="${merge ? R - 1 : R}" fill="${merge ? "var(--panel)" : color(col)}" stroke="${color(col)}" stroke-width="2"/>`;
      const refs = c.refs.map((r) => {
        const cls = r.startsWith("tag: ") ? "tag" : r.startsWith("HEAD") ? "head" : r.includes("/") ? "remote" : "branch";
        return `<span class="cg-ref ${cls}">${esc(r.replace(/^HEAD -> /, "● ").replace(/^tag: /, "🏷 "))}</span>`;
      }).join("");
      const when = new Date(c.time * 1000).toLocaleDateString(locale());
      rows.push(`<div class="cg-commit" data-h="${c.hash}" title="${esc(`${c.hash.slice(0, 10)} · ${c.author} · ${new Date(c.time * 1000).toLocaleString(locale())}\n${c.subject}`)}">
        <svg width="${x(width - 1) + 8}" height="${H}" class="cg-lanes">${svg}</svg>
        <span class="cg-msg">${refs}${esc(c.subject)}</span><span class="cg-meta muted">${esc(c.author.split(" ")[0])} · ${when}</span></div>`);
    }
    const br = await invoke<Branches>("code_git_branches", { root: git.root }).catch(() => null);
    box.innerHTML = branchHint(commits, br) + rows.join("") + (commits.length === 300 ? `<p class="muted pad">показаны последние 300 коммитов</p>` : "");
  }

  /** A just-created branch sits on the same commit as the one it came from, so it has no line of its
   *  own yet: say so instead of leaving only a label. */
  function branchHint(commits: Commit[], br: Branches | null): string {
    const head = commits.find((c) => c.refs.some((r) => r.startsWith("HEAD -> ")));
    if (!head || !br) return "";
    const cur = head.refs.find((r) => r.startsWith("HEAD -> "))!.slice(8);
    const locals = new Set(br.local.map((b) => b.name)), remotes = new Set(br.remote.map((b) => b.name));
    const others = head.refs.filter((r) => r !== cur && !r.startsWith("HEAD") && !r.startsWith("tag: "));
    const upstream = br.local.find((b) => b.name === cur)?.upstream;
    const from = others.find((r) => locals.has(r)) ?? others.find((r) => remotes.has(r) && r !== upstream)?.replace(/^[^/]+\//, "");
    if (!from) return "";
    return `<div class="cg-hint"><span class="cg-ref head">● ${esc(cur)}</span> создана от <b>${esc(from)}</b> — своя линия в графе появится после первого коммита в этой ветке</div>`;
  }


  function drawGit() { drawChanges(); drawGraph(); }
  $(".cg-changes").addEventListener("click", async (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".cg-file");
    if (!row || !git.root) return;
    const file = row.dataset.file!;
    const d = await invoke<string>("code_git_diff", { root: git.root, file }).catch((x) => String(x));
    openReadonly(`diff:${file}`, `Δ ${base(file)}`, d || "нет изменений относительно HEAD");
  });
  $(".cg-changes").addEventListener("dblclick", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".cg-file");
    if (row && git.root) openFile(join(git.root, row.dataset.file!));
  });
  $(".cg-graph").addEventListener("click", async (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".cg-commit");
    if (!row || !git.root) return;
    const h = row.dataset.h!;
    const text = await invoke<string>("code_git_show", { root: git.root, hash: h }).catch((x) => String(x));
    openReadonly(`git:${h}`, h.slice(0, 7), text);
  });
  // ----- branches, sync, commit -----
  const anyDirty = () => tabs.some(isDirty);
  async function gitOp(op: string, args: Record<string, unknown> = {}, label = op): Promise<boolean> {
    if (!git.root) { toast("Это не git-репозиторий", "err"); return false; }
    if (["switch", "merge", "pull"].includes(op) && anyDirty()) {
      if ((await ask("Несохранённые файлы", "Есть несохранённые правки в редакторе. Git поменяет файлы на диске — сначала сохраните их. Продолжить без сохранения?", { ok: "Продолжить", danger: true })) === null) return false;
    }
    const busy = root.querySelectorAll<HTMLButtonElement>(".code-git button");
    busy.forEach((b) => (b.disabled = true));
    try {
      const out = await invoke<string>("code_git_op", { root: git.root, op, name: null, from: null, message: null, force: null, ...args });
      toast(`${label}: ${out.split("\n").filter(Boolean).slice(-2).join(" · ") || "готово"}`);
      return true;
    } catch (e) {
      toast(`${label}: ${String(e).split("\n").slice(0, 4).join(" ")}`, "err");
      return false;
    } finally {
      busy.forEach((b) => (b.disabled = false));
      await afterGitChange();
    }
  }

  /** Files may have changed on disk (switch, pull, merge): refresh tree, git panel and open tabs. */
  async function afterGitChange() {
    await refreshGit(false);
    listing.clear();
    await loadTree();
    if (!gitPanel.hidden) drawGit();
    if (!$(".cg-branches").hidden) drawBranches();
    for (const t of tabs) {
      if (!t.path) continue;
      const r = await invoke<{ text: string; mtime: number }>("code_read", { path: t.path }).catch(() => null);
      if (!r) { t.btn.classList.add("gone"); t.btn.title = `${t.path} — файла больше нет на диске`; continue; }
      t.btn.classList.remove("gone");
      if (toLf(r.text) === t.saved) { t.mtime = r.mtime; continue; }
      if (isDirty(t)) { toast(`«${t.title}» изменился на диске, а у вас несохранённые правки — при сохранении OpsDeck спросит, что оставить`, "err"); continue; }
      const st = t === active ? view.state : t.state;
      const next = st.update({ changes: { from: 0, to: st.doc.length, insert: toLf(r.text) } }).state;
      t.saved = toLf(r.text);
      t.eol = eolOf(r.text);
      t.mtime = r.mtime;
      if (t === active) { view.setState(next); t.state = next; } else t.state = next;
      markDirty(t);
    }
  }

  async function drawBranches() {
    const box = $(".cg-branches");
    if (!git.root) { box.innerHTML = ""; return; }
    const b = await invoke<Branches>("code_git_branches", { root: git.root }).catch((e) => { box.innerHTML = `<p class="err pad">${esc(e)}</p>`; return null; });
    if (!b) return;
    const row = (x: Branch, remote: boolean) => {
      const cur = !remote && x.name === b.current;
      return `<div class="cg-br ${cur ? "current" : ""}" data-b="${esc(x.name)}" data-remote="${remote ? 1 : ""}" title="${esc(`${x.subject}\n${x.upstream ? "↔ " + x.upstream : "без upstream"}`)}">
        <span class="cg-br-mark">${cur ? "●" : ""}</span><span class="tree-label">${esc(x.name)}</span>
        ${x.track ? `<span class="cg-br-track">${esc(x.track.replace("ahead", "↑").replace("behind", "↓").replace(/,\s*/g, " "))}</span>` : ""}
        <span class="cg-br-time muted">${ago(x.time)}</span>
        ${cur ? "" : `<span class="cg-br-acts">${remote ? "" : `<span data-bo="merge" title="Слить «${esc(x.name)}» в текущую ветку">⤵</span><span data-bo="delete" title="Удалить ветку">×</span>`}</span>`}
      </div>`;
    };
    box.innerHTML = `
      <div class="cg-br-new" data-bo="create">${icon("plus", 14)} Новая ветка от «${esc(b.current || "HEAD")}»</div>
      ${b.local.map((x) => row(x, false)).join("")}
      ${b.remote.length ? `<details class="cg-remotes"><summary>Удалённые (${b.remote.length})</summary>${b.remote.map((x) => row(x, true)).join("")}</details>` : ""}`;
  }

  $(".cg-branches").addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>("[data-bo]")?.dataset.bo;
    const rowEl = t.closest<HTMLElement>(".cg-br");
    const name = rowEl?.dataset.b ?? "";
    if (act === "create") {
      const n = await ask("Новая ветка", `Имя ветки (создаётся от «${git.branch || "HEAD"}» и сразу становится текущей):`, { input: "feature/", ok: "Создать" });
      if (n?.trim()) gitOp("create", { name: n.trim() }, "новая ветка");
      return;
    }
    if (act === "merge") {
      if ((await ask("Слить ветку", `Слить «${name}» в «${git.branch}»? (git merge --no-edit)`, { ok: "Слить" })) !== null) gitOp("merge", { name }, "merge");
      return;
    }
    if (act === "delete") {
      if ((await ask("Удалить ветку", `Удалить локальную ветку «${name}»?`, { ok: "Удалить", danger: true })) === null) return;
      const ok = await invoke<string>("code_git_op", { root: git.root, op: "delete", name, from: null, message: null, force: false })
        .then(() => true, async (err) => {
          if (!String(err).includes("not fully merged")) { toast(String(err), "err"); return false; }
          if ((await ask("Ветка не слита", `В «${name}» есть коммиты, которых нет в других ветках. Удалить всё равно (git branch -D)?`, { ok: "Удалить", danger: true })) === null) return false;
          return gitOp("delete", { name, force: true }, "удаление");
        });
      if (ok) { toast(`Ветка «${name}» удалена`); afterGitChange(); }
      return;
    }
    if (rowEl && !rowEl.classList.contains("current")) gitOp("switch", { name }, `переключение на ${name}`);
  });
  $("[data-a=branches]").onclick = () => {
    const box = $(".cg-branches");
    box.hidden = !box.hidden;
    if (!box.hidden) drawBranches();
  };
  $("[data-a=git-fetch]").onclick = () => gitOp("fetch", {}, "fetch");
  $("[data-a=git-pull]").onclick = () => gitOp("pull", {}, "pull");
  $("[data-a=git-push]").onclick = () => gitOp("push", {}, "push");
  const commit = async () => {
    const msg = $<HTMLTextAreaElement>(".cg-msg-in").value.trim();
    if (!msg) { toast("Напишите сообщение коммита", "err"); $(".cg-msg-in").focus(); return; }
    if (anyDirty() && (await ask("Несохранённые файлы", "В коммит попадёт то, что сохранено на диске. Несохранённые правки в редакторе в него не войдут. Продолжить?", { ok: "Закоммитить" })) === null) return;
    if (await gitOp("commit", { message: msg }, "commit")) $<HTMLTextAreaElement>(".cg-msg-in").value = "";
  };
  $("[data-a=git-commit]").onclick = commit;
  $(".cg-msg-in").addEventListener("keydown", (e) => { if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); commit(); } });

  // ----- resizable panels -----
  function splitter(handle: HTMLElement, target: HTMLElement, prop: "width" | "height", key: string, sign: 1 | -1, min: number, max: () => number) {
    const saved = Number(ls.get(key));
    if (saved) target.style[prop] = `${saved}px`;
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const start = prop === "width" ? e.clientX : e.clientY;
      const size0 = prop === "width" ? target.offsetWidth : target.offsetHeight;
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("drag");
      const move = (ev: PointerEvent) => {
        const d = ((prop === "width" ? ev.clientX : ev.clientY) - start) * sign;
        target.style[prop] = `${Math.max(min, Math.min(max(), size0 + d))}px`;
        view.requestMeasure();
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.classList.remove("drag");
        ls.set(key, String(prop === "width" ? target.offsetWidth : target.offsetHeight));
        con?.resize();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
    // double-click: back to the default size
    handle.addEventListener("dblclick", () => { target.style[prop] = ""; ls.set(key, ""); view.requestMeasure(); con?.resize(); });
  }
  const consoleEl = $(".code-console");
  splitter($("[data-split=side]"), $(".code-side"), "width", "opsdeck.code.sideW", 1, 160, () => root.clientWidth * 0.45);
  splitter($("[data-split=git]"), gitPanel, "width", "opsdeck.code.gitW", -1, 220, () => root.clientWidth * 0.5);
  splitter($(".code-hsplit"), consoleEl, "height", "opsdeck.code.consoleH", -1, 80, () => root.clientHeight - 160);

  // ----- mini console in the project folder -----
  let con: PtyTerminal | null = null;
  let conDead = false;
  function startConsole() {
    const hostEl = $(".cc-host");
    hostEl.innerHTML = "";
    conDead = false;
    const c = (con = new PtyTerminal(hostEl, { cwd: project || undefined }));
    attachPathLinks(c);
    $(".cc-cwd").textContent = project || "~";
    c.onExit = () => { conDead = true; $(".cc-cwd").textContent = `${project || "~"} — shell завершён, ↻ — запустить снова`; };
  }
  /** The console goes to the folder of a newly opened project: typed `cd` for an idle shell, a fresh shell otherwise. */
  function followConsole() {
    if (!con) return; // not started yet: it will start in the project folder
    if (conDead || !con.launched) { con.dispose(); startConsole(); return; }
    const line = cdCommand(con.launched, project);
    if (line === null) return toast("Консоль в WSL: перейдите в папку проекта вручную", "err");
    if (con.blocks.running) return toast(`В консоли идёт «${con.blocks.running}» — папку не меняю, чтобы не набрать cd в программу`, "err");
    con.send(line + "\r");
    $(".cc-cwd").textContent = project;
  }
  function toggleConsole(show?: boolean) {
    const vis = show ?? consoleEl.hidden;
    consoleEl.hidden = $(".code-hsplit").hidden = !vis;
    $("[data-a=console]").classList.toggle("on", vis);
    ls.set("opsdeck.code.console", vis ? "1" : "0");
    if (vis) {
      if (!con) startConsole();
      requestAnimationFrame(() => { view.requestMeasure(); con?.resize(); con?.term.focus(); });
    } else {
      requestAnimationFrame(() => { view.requestMeasure(); view.focus(); });
    }
  }
  root.querySelectorAll<HTMLElement>("[data-a=console]").forEach((b) => (b.onclick = () => toggleConsole()));
  $("[data-a=cc-restart]").onclick = () => { con?.dispose(); con = null; startConsole(); con!.term.focus(); };
  $("[data-a=cc-tab]").onclick = () => window.dispatchEvent(new CustomEvent("open-terminal", { detail: { cwd: project || undefined } }));
  // Ctrl+F with the focus outside the editor (the tree, an empty tab bar): search in the open file
  window.addEventListener("keydown", (e) => {
    if (root.hidden || !active || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.code !== "KeyF") return;
    const t = e.target as HTMLElement;
    if (view.dom.contains(t) || t.closest("input, textarea, select, .code-console, dialog")) return;
    e.preventDefault();
    openSearchPanel(view);
    view.focus();
  });
  // Ctrl+` (the key left of 1 on any layout) toggles the console while the IDE is shown
  window.addEventListener("keydown", (e) => {
    if (root.hidden || !e.ctrlKey || e.code !== "Backquote") return;
    e.preventDefault();
    toggleConsole();
  }, true);

  const toggleGit = (show?: boolean) => {
    gitPanel.hidden = !(show ?? gitPanel.hidden);
    $("[data-split=git]").hidden = gitPanel.hidden;
    ls.set("opsdeck.code.git", gitPanel.hidden ? "0" : "1");
    $("[data-a=git-toggle]").classList.toggle("on", !gitPanel.hidden);
    if (!gitPanel.hidden) refreshGit(false).then(drawGit);
  };
  $("[data-a=git-toggle]").onclick = () => toggleGit();
  $("[data-a=git-refresh]").onclick = () => refreshGit().then(drawGit);

  // ----- wiring -----
  window.addEventListener("open-in-code", (e) => {
    const { path, line } = (e as CustomEvent<{ path: string; line?: number }>).detail;
    window.dispatchEvent(new CustomEvent("show-view", { detail: "code" }));
    // a folder becomes the project; a file outside the project opens anyway
    invoke<Entry[]>("fs_list", { path, hidden: false }).then(() => setProject(path), () => openFile(path, line));
  });
  window.addEventListener("view-shown", (e) => {
    if ((e as CustomEvent).detail !== "code") return;
    requestAnimationFrame(() => { view.requestMeasure(); con?.resize(); });
    // the console was open last time: bring it back on the first visit
    if (!con && consoleEl.hidden && ls.get("opsdeck.code.console") === "1") toggleConsole(true);
    refreshGit();
  });
  // a branch switched or a commit made in a terminal: notice it without the ⟳ button
  let gitStamp = "";
  setInterval(async () => {
    if (root.hidden || document.hidden || !git.root) return;
    const stamp = await invoke<string>("code_git_stamp", { root: git.root }).catch(() => "");
    if (!stamp || stamp === gitStamp) return;
    const first = !gitStamp;
    gitStamp = stamp;
    if (first) return;
    await refreshGit(false);
    if (!gitPanel.hidden) drawGit();
    if (!$(".cg-branches").hidden) drawBranches();
  }, 2000);
  window.addEventListener("beforeunload", (e) => { if (tabs.some(isDirty)) e.preventDefault(); });
  registerProvider(() => [
    { group: "IDE", title: "Открыть папку проекта", run: () => { window.dispatchEvent(new CustomEvent("show-view", { detail: "code" })); $("[data-a=open]").click(); } },
    { group: "IDE", title: "Консоль в папке проекта: показать/скрыть", hint: "Ctrl+`", run: () => { window.dispatchEvent(new CustomEvent("show-view", { detail: "code" })); toggleConsole(); } },
    { group: "IDE", title: "Git: новая ветка", run: () => { window.dispatchEvent(new CustomEvent("show-view", { detail: "code" })); toggleGit(true); $(".cg-branches").hidden = false; drawBranches(); } },
    { group: "IDE", title: "Открыть в IDE папку терминала", run: () => { window.dispatchEvent(new CustomEvent("show-view", { detail: "code" })); $("[data-a=from-term]").click(); } },
    ...tabs.filter((t) => t.path).map((t) => ({ group: "IDE", title: t.title, hint: t.path!, run: () => { window.dispatchEvent(new CustomEvent("show-view", { detail: "code" })); activate(t); } })),
  ]);

  // read before the first activate(), which rewrites the saved list
  const prevTabs = JSON.parse(ls.get("opsdeck.code.tabs") ?? "[]") as string[];
  const prevActive = ls.get("opsdeck.code.active");
  fillRecent();
  activate(null);
  if (ls.get("opsdeck.code.git") === "1") toggleGit(true);

  loadTree().then(async () => {
    // reopen the files that were open last time
    for (const p of prevTabs) {
      const r = await invoke<{ text: string; mtime: number }>("code_read", { path: p }).catch(() => null);
      if (r) addTab(p, base(p), p, r.text, r.mtime, false);
    }
    activate(tabs.find((t) => t.path === prevActive) ?? tabs[0] ?? null);
  });
}
