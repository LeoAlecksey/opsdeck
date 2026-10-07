import { relTo } from "./paths";
import { fileIcon, folderIcon } from "./fileicons";
import { icon } from "./icons";
import { invoke } from "@tauri-apps/api/core";
import type { PtyTerminal } from "./pty";
import { ask, esc, toast } from "./ui";

type Entry = { name: string; dir: boolean; link: boolean; size: number };
type Git = { root: string; branch: string; files: Record<string, string> };
type Editor = { id: string; name: string; tui: boolean };
type TermSpec = { program: string; args: string[]; cwd: string; title: string };

// ---------- editor choice (per viewer) ----------

const load = (k: string, d = "") => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

let editors: Editor[] | null = null;
async function detectEditors(): Promise<Editor[]> {
  editors ??= await invoke<Editor[]>("editors_detect").catch(() => []);
  return editors;
}

async function currentEditor(): Promise<string> {
  const saved = load("opsdeck.editor");
  if (saved === "custom" || saved === "opsdeck" || (saved && (await detectEditors()).some((e) => e.id === saved))) return saved;
  // nothing chosen yet: the built-in IDE
  return "opsdeck";
}

/** Open a file (optionally at a line) or a folder in the chosen IDE/editor. */
export async function openInEditor(path: string, line?: number) {
  const editor = await currentEditor();
  if (editor === "opsdeck") {
    window.dispatchEvent(new CustomEvent("open-in-code", { detail: { path, line } }));
    return;
  }
  if (!editor) {
    toast("Не найден ни один редактор. В панели «Файлы» выберите «Своя команда…»", "err");
    return;
  }
  try {
    const spec = await invoke<TermSpec | null>("editor_open", {
      editor, path, line: line ?? null, custom: editor === "custom" ? load("opsdeck.editor.custom") : null,
    });
    // terminal editors (vim, nvim, helix…) open as a terminal tab
    if (spec) window.dispatchEvent(new CustomEvent("open-terminal", { detail: { title: spec.title, program: spec.program, args: spec.args, cwd: spec.cwd } }));
  } catch (e) { toast(String(e), "err"); }
}

const join = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);
const parent = (p: string) => { const i = p.replace(/\/+$/, "").lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); };
const quote = (p: string) => (/^[\w@%+=:,./~-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

// ---------- Ctrl+click on paths in terminal output ----------

// ./a/b, ../x, ~/y, /etc/z, dir/file — or a bare file with an extension; optional :line[:col]
const PATH_RE = /(?:~|\.{1,2})?(?:[\w@.+-]*\/[\w@.+/-]*[\w@+-]|[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,10})(?::(\d+)(?::\d+)?)?/g;

export function attachPathLinks(pty: PtyTerminal) {
  const cache = new Map<string, Record<string, string>>();
  pty.term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = pty.term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      const found: { text: string; path: string; line?: number; x: number }[] = [];
      for (const m of line.matchAll(PATH_RE)) {
        const path = m[0].replace(/(:\d+){1,2}$/, "");
        if (path.length < 3 || /^\d+(\.\d+)+$/.test(path)) continue; // versions, IPs
        found.push({ text: m[0], path, line: m[1] ? Number(m[1]) : undefined, x: m.index! + 1 });
      }
      if (!found.length) return callback(undefined);
      const cwd = pty.blocks.cwd;
      const key = `${cwd}\n${line}`;
      const done = (hits: Record<string, string>) => {
        callback(found.filter((f) => hits[f.path]).map((f) => ({
          text: f.text,
          range: { start: { x: f.x, y }, end: { x: f.x + f.text.length - 1, y } },
          decorations: { underline: true, pointerCursor: true },
          activate: (ev: MouseEvent) => {
            if (ev.ctrlKey || ev.metaKey) openInEditor(hits[f.path], f.line);
          },
          hover: () => {},
        })));
      };
      const hit = cache.get(key);
      if (hit) return done(hit);
      invoke<Record<string, string>>("fs_resolve", { cwd: cwd || "~", candidates: [...new Set(found.map((f) => f.path))] })
        .then((r) => {
          if (cache.size > 300) cache.clear();
          cache.set(key, r);
          done(r);
        })
        .catch(() => callback(undefined));
    },
  });
}

// ---------- the panel ----------

export type FilesHost = {
  /** cwd of the active terminal pane (from the shell integration), if known */
  cwd(): string | undefined;
  paste(text: string): void;
};

export function mountFiles(panel: HTMLElement, host: FilesHost) {
  panel.innerHTML = `
    <div class="tabbar fx-head">
      <button class="icon" data-f="up" title="На уровень выше">↑</button>
      <span class="fx-root mono" title=""></span>
      <span class="spacer"></span>
      <button class="icon" data-f="follow" title="Следовать за cd в терминале">⌖</button>
      <button class="icon" data-f="hidden" title="Показывать скрытые файлы">.*</button>
      <button class="icon" data-f="refresh" title="Обновить">${icon("refresh", 16)}</button>
    </div>
    <div class="fx-bar">
      <select class="fx-editor" title="Чем открывать"></select>
      <button class="primary" data-f="open-root" title="Открыть проект в IDE: корень git-репозитория, иначе эта папка">Открыть в IDE</button>
    </div>
    <div class="fx-git muted"></div>
    <div class="fx-tree" tabindex="0"></div>`;
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => panel.querySelector<T>(s)!;
  const tree = $(".fx-tree"), rootEl = $(".fx-root"), gitEl = $(".fx-git"), sel = $<HTMLSelectElement>(".fx-editor");

  let root = "";
  let follow = load("opsdeck.files.follow", "1") === "1";
  let hidden = load("opsdeck.files.hidden") === "1";
  const expanded = new Set<string>();
  const listing = new Map<string, Entry[] | string>(); // dir → entries or error text
  let git: Git = { root: "", branch: "", files: {} };
  let dirty = new Set<string>(); // folders that contain changes (relative to git root)

  const syncButtons = () => {
    $("[data-f=follow]").classList.toggle("on", follow);
    $("[data-f=hidden]").classList.toggle("on", hidden);
  };

  async function fillEditors() {
    const list = await detectEditors();
    const cur = await currentEditor();
    sel.innerHTML = `<option value="opsdeck">OpsDeck IDE (встроенная)</option>` + list.map((e) => `<option value="${e.id}">${esc(e.name)}${e.tui ? " (в терминале)" : ""}</option>`).join("")
      + `<option value="custom">Своя команда…</option>`;
    sel.value = cur || "custom";
  }
  sel.onchange = async () => {
    if (sel.value === "custom") {
      const cmd = await ask("Своя команда редактора",
        "Команда запуска: {path} — файл или папка, {line} — строка, {dir} — папка. Например: emacsclient -n +{line} {path}",
        { input: load("opsdeck.editor.custom", ""), placeholder: "myeditor --goto {path}:{line}", ok: "Сохранить" });
      if (cmd === null || !cmd.trim()) return fillEditors();
      save("opsdeck.editor.custom", cmd.trim());
    }
    save("opsdeck.editor", sel.value);
  };

  async function readDir(dir: string) {
    const r = await invoke<Entry[]>("fs_list", { path: dir, hidden }).catch((e) => String(e));
    listing.set(dir, r);
  }

  async function refreshGit() {
    git = root ? await invoke<Git>("fs_git_status", { path: root }) : { root: "", branch: "", files: {} };
    dirty = new Set();
    for (const f of Object.keys(git.files)) {
      const parts = f.split("/");
      for (let i = 1; i < parts.length; i++) dirty.add(parts.slice(0, i).join("/"));
    }
    gitEl.innerHTML = git.root
      ? `⎇ <b>${esc(git.branch || "detached")}</b>${Object.keys(git.files).length ? ` · изменено: ${Object.keys(git.files).length}` : " · чисто"}`
      : "";
  }

  const rel = (abs: string) => relTo(git.root, abs) ?? "";
  const gitClass = (abs: string, dir: boolean) => {
    const r = rel(abs);
    if (!r) return "";
    const c = git.files[r];
    if (c) return c === "??" ? "g-new" : c.includes("D") ? "g-del" : c.includes("A") ? "g-new" : "g-mod";
    return dir && dirty.has(r) ? "g-dirty" : "";
  };

  function rows(dir: string, depth: number): string {
    const l = listing.get(dir);
    if (l === undefined) return `<div class="fx-row muted" style="--d:${depth}">…</div>`;
    if (typeof l === "string") return `<div class="fx-row err" style="--d:${depth}">${esc(l)}</div>`;
    if (!l.length) return `<div class="fx-row muted" style="--d:${depth}">пусто</div>`;
    return l.map((e) => {
      const p = join(dir, e.name);
      const open = e.dir && expanded.has(p);
      return `<div class="fx-row ${e.dir ? "dir" : "file"} ${gitClass(p, e.dir)}" style="--d:${depth}" data-p="${esc(p)}" data-dir="${e.dir ? 1 : 0}" title="${esc(p)}">
          <span class="fx-caret">${e.dir ? (open ? "▾" : "▸") : ""}</span><span class="fx-ico">${e.dir ? folderIcon(e.name, open) : fileIcon(e.name)}</span><span class="fx-name">${esc(e.name)}${e.link ? " ↪" : ""}</span>
          <span class="fx-acts">
            <button class="icon" data-r="ide" title="Открыть в IDE">↗</button>
            <button class="icon" data-r="paste" title="Вставить путь в терминал">⎘</button>
            ${e.dir ? `<button class="icon" data-r="cd" title="cd в эту папку">⤷</button>` : ""}
          </span>
        </div>${open ? rows(p, depth + 1) : ""}`;
    }).join("");
  }

  function draw() {
    rootEl.textContent = root || "—";
    rootEl.title = root;
    tree.innerHTML = root ? rows(root, 0) : `<p class="muted fx-empty">Откройте локальную вкладку терминала — дерево покажет её текущую папку.</p>`;
  }

  async function setRoot(dir: string) {
    if (!dir) return;
    if (dir !== root) {
      root = dir;
      listing.clear();
      expanded.clear();
      draw();
    }
    await Promise.all([readDir(root), refreshGit()]);
    draw();
  }

  async function reload() {
    listing.clear();
    await Promise.all([readDir(root), ...[...expanded].map(readDir), refreshGit()]);
    draw();
  }

  tree.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>(".fx-row[data-p]");
    if (!row) return;
    const p = row.dataset.p!, isDir = row.dataset.dir === "1";
    const act = t.closest<HTMLElement>("[data-r]")?.dataset.r;
    if (act === "ide") return openInEditor(p);
    if (act === "paste") return host.paste(quote(p) + " ");
    if (act === "cd") return host.paste(`cd ${quote(p)}\r`);
    if (!isDir) return openInEditor(p);
    if (expanded.has(p)) expanded.delete(p);
    else {
      expanded.add(p);
      if (!listing.has(p)) { draw(); await readDir(p); }
    }
    draw();
  });
  tree.addEventListener("dblclick", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".fx-row[data-dir='1']");
    if (row && !(e.target as HTMLElement).closest("[data-r]")) {
      follow = false;
      save("opsdeck.files.follow", "0");
      syncButtons();
      setRoot(row.dataset.p!);
    }
  });

  panel.querySelector(".fx-head")!.addEventListener("click", (e) => {
    const f = (e.target as HTMLElement).closest<HTMLElement>("[data-f]")?.dataset.f;
    if (f === "up" && root) { follow = false; save("opsdeck.files.follow", "0"); setRoot(parent(root)); }
    if (f === "follow") { follow = !follow; save("opsdeck.files.follow", follow ? "1" : "0"); if (follow) setRoot(host.cwd() ?? root); }
    if (f === "hidden") { hidden = !hidden; save("opsdeck.files.hidden", hidden ? "1" : "0"); reload(); }
    if (f === "refresh") reload();
    syncButtons();
  });
  // the project = the git repository when inside one, else the shown folder
  $("[data-f=open-root]").onclick = () => root && openInEditor(git.root || root);

  // follow the active pane's cwd; refresh git marks now and then while visible
  let lastCwd = "";
  let tick = 0;
  setInterval(() => {
    if (panel.hidden || panel.offsetParent === null) return;
    const c = host.cwd() ?? "";
    if (follow && c && c !== lastCwd) { lastCwd = c; setRoot(c); return; }
    if (++tick % 5 === 0 && root) refreshGit().then(draw);
  }, 1000);

  syncButtons();
  fillEditors();
  return {
    shown() {
      const c = host.cwd();
      if (follow && c) setRoot(c);
      else if (root) reload();
      else setRoot(c ?? "~");
    },
  };
}
