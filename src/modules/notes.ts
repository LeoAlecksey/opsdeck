import { eolOf, toLf, withEol, type Eol } from "./eol";
import { t as i18nT } from "../i18n";
import { helpBtn } from "./help";
import { icon } from "./icons";
import { invoke } from "@tauri-apps/api/core";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { listen } from "@tauri-apps/api/event";
import { ask, esc, toast } from "./ui";
import { registerProvider } from "./palette";
import { fileIcon, folderIcon } from "./fileicons";
import { setFrontTags, tagsOf, taskDialog, ymd } from "./taskkit";
import { aiAgent, DEFAULT_AGENT, fileRef } from "./ai-agents";

type VaultEntry = { name: string; path: string; exists: boolean; obsidian: boolean; found: boolean };
type TagInfo = { tag: string; notes: string[] };

type Note = { path: string; mtime: number };
type Vault = { root: string; name: string; notes: Note[]; folders?: string[] };
type Hit = { path: string; line: number; text: string };

/** [[Note]] / [[Note|alias]] → links handled by the click handler below. */
function wikilinks(md: string): string {
  return md.replace(/\[\[([^\]|#]+)(#[^\]|]*)?(\|([^\]]+))?\]\]/g, (_m, target: string, _h, _a, alias?: string) =>
    `[${alias ?? target}](#note:${encodeURIComponent(target.trim())})`);
}

export function mountNotes(root: HTMLElement) {
  root.classList.add("notes");
  root.innerHTML = `
    <aside class="notes-side">
      <div class="side-head"><button class="ghost vault-btn" data-a="vaults" title="Хранилища: переключить, создать новое, открыть папку"><span class="vault-name">Заметки</span> ▾</button>
        <span class="row">
          <button class="icon" data-a="daily" title="Заметка на сегодня">${icon("calendar", 16)}</button>
          <button class="icon" data-a="new" title="Новая заметка">${icon("plus", 16)}</button>
          <button class="icon" data-a="collapse" title="Свернуть все папки">${icon("splitV", 16)}</button>
          <button class="icon" data-a="reload" title="Обновить">${icon("refresh", 16)}</button>
        </span></div>
      <div class="vault-menu" hidden></div>
      <input class="notes-q" placeholder="поиск по заметкам…" spellcheck="false" />
      <div class="notes-list"></div>
    </aside>
    <div class="notes-main">
      <div class="notes-bar">
        <strong class="note-path muted">${i18nT("выберите заметку")}</strong><span class="dirty" hidden>●</span>
        <span class="spacer"></span>
        <button class="ghost" data-a="task" disabled title="Вставить задачу: срок, напоминание, приоритет, теги">${icon("plus", 16)} Задача</button>
        <div class="seg"><button data-m="edit">Редактор</button><button data-m="view">Просмотр</button></div>
        <button class="ghost" data-a="mention" disabled></button>
        <button data-a="save" title="Ctrl+S" disabled>Сохранить</button>
        ${helpBtn("notes")}
        <button class="ghost" data-a="obsidian" disabled title="Открыть эту заметку в приложении Obsidian">Obsidian ↗</button>
      </div>
      <div class="note-tags" hidden></div>
      <textarea class="note-editor" spellcheck="false" hidden></textarea>
      <article class="note-view md" hidden></article>
    </div>`;

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const listEl = $(".notes-list"), q = $<HTMLInputElement>(".notes-q"), editor = $<HTMLTextAreaElement>(".note-editor");
  const view = $(".note-view"), dirtyEl = $(".dirty"), saveBtn = $<HTMLButtonElement>("[data-a=save]");
  let vault: Vault | null = null;
  let current: string | null = null;
  let saved = "";
  let eol: Eol = "\n"; // the open note's line endings, kept on save
  let mode: "edit" | "view" = (localStorage.getItem("opsdeck.notes.mode") as "edit" | "view") ?? "view";

  const dirty = () => current !== null && editor.value !== saved;
  // unsaved changes: ● next to the name and a turquoise frame around the note, gone after saving
  const markDirty = () => { const d = dirty(); dirtyEl.hidden = !d; saveBtn.disabled = !d; root.classList.toggle("note-dirty", d); };

  let allTags: TagInfo[] = [];
  let tagFilter = "";
  async function loadVault() {
    try {
      vault = await invoke<Vault>("notes_list");
      $(".vault-name").textContent = vault.name;
      $(".vault-btn").title = `${vault.root}\nХранилища: переключить, создать новое, открыть папку`;
      allTags = await invoke<TagInfo[]>("notes_tags").catch(() => []);
      drawList();
    } catch (e) {
      vault = null;
      listEl.innerHTML = `<p class="muted pad">${esc(e)}</p>`;
    }
  }

  type Folder = { name: string; path: string; folders: Map<string, Folder>; notes: Note[]; count: number };

  function buildTree(notes: Note[], dirs: string[] = []): Folder {
    const root: Folder = { name: "", path: "", folders: new Map(), notes: [], count: 0 };
    // empty folders too, so a note can be created in / dragged to them
    for (const d of dirs) {
      let f = root;
      for (const part of d.split("/")) {
        const path = f.path ? `${f.path}/${part}` : part;
        if (!f.folders.has(part)) f.folders.set(part, { name: part, path, folders: new Map(), notes: [], count: 0 });
        f = f.folders.get(part)!;
      }
    }
    for (const n of notes) {
      const parts = n.path.split("/");
      let f = root;
      f.count++;
      for (const part of parts.slice(0, -1)) {
        const path = f.path ? `${f.path}/${part}` : part;
        if (!f.folders.has(part)) f.folders.set(part, { name: part, path, folders: new Map(), notes: [], count: 0 });
        f = f.folders.get(part)!;
        f.count++;
      }
      f.notes.push(n);
    }
    return root;
  }

  const openDirs = new Set<string>(JSON.parse(localStorage.getItem("opsdeck.notes.open") ?? "[]") as string[]);
  const saveOpen = () => localStorage.setItem("opsdeck.notes.open", JSON.stringify([...openDirs]));
  const title = (p: string) => p.split("/").pop()!.replace(/\.md$/, "");
  const noteBtn = (n: Note, depth: number, label = title(n.path)) =>
    `<button class="note-item ${n.path === current ? "active" : ""}" style="--depth:${depth}" data-p="${esc(n.path)}" title="${esc(n.path)}">
      <span class="tree-icon">${fileIcon(n.path)}</span><span class="tree-label">${esc(label)}</span><span class="tree-more" data-more="note" title="Действия">⋯</span></button>`;

  function renderFolder(f: Folder, depth: number): string {
    const folders = [...f.folders.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const notes = [...f.notes].sort((a, b) => title(a.path).localeCompare(title(b.path), undefined, { numeric: true }));
    return folders.map((d) => `
      <div class="tree-dir ${openDirs.has(d.path) ? "open" : ""}" data-dir="${esc(d.path)}">
        <button class="tree-row" style="--depth:${depth}"><span class="tree-caret">▸</span><span class="tree-icon">${folderIcon(d.name, openDirs.has(d.path))}</span>
          <span class="tree-label">${esc(d.name)}</span><span class="tree-count">${d.count}</span>
          <span class="tree-add" data-add="${esc(d.path)}" title="Новая заметка в этой папке">${icon("plus", 14)}</span><span class="tree-more" data-more="dir" title="Действия">⋯</span></button>
        <div class="tree-children" style="--guide:${depth}">${openDirs.has(d.path) ? renderFolder(d, depth + 1) : ""}</div>
      </div>`).join("") + notes.map((n) => noteBtn(n, depth)).join("");
  }

  let tree: Folder | null = null;

  function drawList() {
    if (!vault) return;
    if (q.value.trim().length >= 2) return search();
    if (tagFilter) return drawTagged();
    tree = buildTree(vault.notes, vault.folders);
    const recent = [...vault.notes].sort((a, b) => b.mtime - a.mtime).slice(0, 6);
    const recentOpen = localStorage.getItem("opsdeck.notes.recent") !== "0";
    listEl.innerHTML = `
      <div class="tree-dir tree-section ${recentOpen ? "open" : ""}" data-section="recent">
        <button class="tree-row" style="--depth:0"><span class="tree-caret">▸</span><span class="tree-label">Недавние</span></button>
        <div class="tree-children">${recent.map((n) => noteBtn(n, 1)).join("")}</div>
      </div>
      ${allTags.length ? `<div class="tree-dir tree-section ${localStorage.getItem("opsdeck.notes.tagsOpen") === "1" ? "open" : ""}" data-section="tags">
        <button class="tree-row" style="--depth:0"><span class="tree-caret">▸</span><span class="tree-label">Теги</span><span class="tree-count">${allTags.length}</span></button>
        <div class="tree-children"><div class="side-tags">${allTags.map((t) => `<span class="tag-chip" data-tag="${esc(t.tag)}">#${esc(t.tag)} <b>${t.notes.length}</b></span>`).join("")}</div></div>
      </div>` : ""}
      <div class="tree-sep"></div>
      ${renderFolder(tree, 0)}`;
  }

  /** Notes with the chosen tag. */
  function drawTagged() {
    const notes = allTags.find((t) => t.tag === tagFilter)?.notes ?? [];
    listEl.innerHTML = `<div class="tag-filter"><span class="tag-chip on">#${esc(tagFilter)}</span><span class="muted">${notes.length} заметок</span><span class="spacer"></span><button class="icon" data-untag title="Сбросить фильтр">${icon("close", 14)}</button></div>
      ${notes.map((p) => noteBtn({ path: p, mtime: 0 }, 0, p.replace(/\.md$/, ""))).join("")}`;
  }

  /** Expands the folders on the way to `path` so the active note is visible in the tree. */
  function reveal(path: string) {
    const parts = path.split("/").slice(0, -1);
    parts.forEach((_, i) => openDirs.add(parts.slice(0, i + 1).join("/")));
    saveOpen();
  }

  function findFolder(path: string): Folder | null {
    let f = tree;
    for (const part of path.split("/")) f = f?.folders.get(part) ?? null;
    return f;
  }

  let lastFolder = "";
  listEl.addEventListener("click", (e) => {
    const add = (e.target as HTMLElement).closest<HTMLElement>(".tree-add");
    if (add) { e.stopPropagation(); newNote(add.dataset.add!); return; }
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".tag-chip[data-tag]");
    if (chip) { tagFilter = chip.dataset.tag!; drawList(); return; }
    if ((e.target as HTMLElement).closest("[data-untag]")) { tagFilter = ""; drawList(); return; }
    const more = (e.target as HTMLElement).closest<HTMLElement>(".tree-more");
    if (more) { e.stopPropagation(); itemMenu(more.closest<HTMLElement>(".note-item, .tree-row")!, more.getBoundingClientRect()); return; }
    const row = (e.target as HTMLElement).closest<HTMLElement>(".tree-row");
    if (!row) return;
    const dir = row.parentElement!;
    if (dir.dataset.dir !== undefined) lastFolder = dir.dataset.dir;
    if (dir.dataset.section === "recent" || dir.dataset.section === "tags") {
      dir.classList.toggle("open");
      localStorage.setItem(dir.dataset.section === "recent" ? "opsdeck.notes.recent" : "opsdeck.notes.tagsOpen", dir.classList.contains("open") ? "1" : "0");
      return;
    }
    const path = dir.dataset.dir!;
    const children = dir.querySelector<HTMLElement>(":scope > .tree-children")!;
    const isOpen = dir.classList.toggle("open");
    row.querySelector(".tree-icon")!.innerHTML = folderIcon(path.split("/").pop()!, isOpen);
    if (isOpen) {
      openDirs.add(path);
      const f = findFolder(path);
      const depth = path.split("/").length;
      if (f && !children.innerHTML.trim()) children.innerHTML = renderFolder(f, depth);
    } else {
      openDirs.delete(path);
    }
    saveOpen();
  });

  async function search() {
    const hits = await invoke<Hit[]>("note_search", { query: q.value }).catch(() => [] as Hit[]);
    listEl.innerHTML = hits.length ? hits.map((h) => `
      <button class="note-item hit" data-p="${esc(h.path)}">
        <span>${esc(h.path.replace(/\.md$/, ""))}${h.line ? `<span class="muted">:${h.line}</span>` : ""}</span>
        ${h.text ? `<span class="muted hit-text">${esc(h.text)}</span>` : ""}</button>`).join("") : `<p class="muted pad">Ничего не найдено</p>`;
  }

  async function openNote(path: string, line?: number) {
    if (dirty() && (await ask("Несохранённые изменения", `Изменения в «${current}» будут потеряны. Продолжить?`, { ok: "Не сохранять", danger: true })) === null) return;
    try {
      const text = await invoke<string>("note_read", { path });
      current = path;
      eol = eolOf(text);
      saved = toLf(text);
      if (!q.value.trim()) { reveal(path); drawList(); }
      editor.value = text;
      $(".note-path").textContent = path.replace(/\.md$/, "");
      $(".note-path").classList.remove("muted");
      $<HTMLButtonElement>("[data-a=obsidian]").disabled = false;
      $<HTMLButtonElement>("[data-a=mention]").disabled = false;
      $<HTMLButtonElement>("[data-a=task]").disabled = false;
      drawNoteTags();
      const fp = fullPath(path);
      invoke("ide_editor", { editor: { uri: `file://${fp}`, filePath: fp, label: title(path), isActive: true, isDirty: false, languageId: "markdown" } }).catch(() => {});
      markDirty();
      setMode(mode);
      listEl.querySelectorAll<HTMLElement>(".note-item").forEach((b) => b.classList.toggle("active", b.dataset.p === path));
      if (line) {
        // jump to the line: in the editor select it, in the view scroll to the matching task
        const lines = editor.value.split("\n");
        const from = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
        if (mode === "edit") {
          editor.focus();
          editor.setSelectionRange(from, from + (lines[line - 1]?.length ?? 0));
          editor.scrollTop = Math.max(0, (line - 5) * parseFloat(getComputedStyle(editor).lineHeight || "20"));
        } else {
          const idx = taskLines().indexOf(line - 1);
          const box = view.querySelectorAll<HTMLElement>("input[type=checkbox]")[idx];
          box?.closest("li")?.scrollIntoView({ block: "center" });
          box?.closest("li")?.classList.add("flash");
        }
      }
    } catch (e) { toast(String(e), "err"); }
  }

  // ----- tags of the open note -----
  function drawNoteTags() {
    const bar = $(".note-tags");
    if (!current) { bar.hidden = true; return; }
    const { all, front } = tagsOf(editor.value);
    bar.hidden = false;
    bar.innerHTML = all.map((t) => `<span class="tag-chip ${front.includes(t) ? "" : "inline"}" title="${front.includes(t) ? "Тег заметки" : "Тег в тексте заметки"}">#${esc(t)}${front.includes(t) ? `<span class="tag-x" data-rm="${esc(t)}" title="Убрать тег">${icon("close", 14)}</span>` : ""}</span>`).join("")
      + `<span class="tag-add"><input class="tag-in" list="note-tag-list" placeholder="＋ тег" spellcheck="false" autocomplete="off" />
         <datalist id="note-tag-list">${allTags.map((t) => `<option value="${esc(t.tag)}">`).join("")}</datalist></span>`;
  }
  $(".note-tags").addEventListener("click", (e) => {
    const rm = (e.target as HTMLElement).closest<HTMLElement>("[data-rm]")?.dataset.rm;
    if (!rm) return;
    editor.value = setFrontTags(editor.value, tagsOf(editor.value).front.filter((t) => t !== rm));
    markDirty(); save().then(refreshTags); drawNoteTags(); if (mode === "view") render();
  });
  $(".note-tags").addEventListener("keydown", (e) => {
    const inp = e.target as HTMLInputElement;
    if (!inp.classList.contains("tag-in") || (e.key !== "Enter" && e.key !== ",")) return;
    e.preventDefault();
    const add = inp.value.split(/[\s,]+/).map((t) => t.replace(/^#/, "").trim()).filter(Boolean);
    if (!add.length) return;
    const front = tagsOf(editor.value).front;
    editor.value = setFrontTags(editor.value, [...front, ...add.filter((t) => !front.includes(t))]);
    markDirty(); save().then(refreshTags); drawNoteTags(); if (mode === "view") render();
    $<HTMLInputElement>(".tag-in").focus();
  });
  async function refreshTags() { allTags = await invoke<TagInfo[]>("notes_tags").catch(() => allTags); if (!q.value.trim()) drawList(); }

  // ----- tasks inside a note -----
  /** Line numbers (0-based) of task lines outside code blocks, in document order. */
  function taskLines(): number[] {
    const out: number[] = [];
    let fence = false;
    editor.value.split("\n").forEach((l, i) => {
      if (l.trimStart().startsWith("```")) fence = !fence;
      else if (!fence && /^\s*[-*+] \[[ xX]\] /.test(l)) out.push(i);
    });
    return out;
  }
  $("[data-a=task]").onclick = async () => {
    if (!current) return;
    const r = await taskDialog({ allTags: allTags.map((t) => t.tag) });
    if (!r) return;
    const lines = editor.value.split("\n");
    // under the cursor line in the editor, otherwise at the end of the note
    let at = lines.length;
    if (mode === "edit") at = editor.value.slice(0, editor.selectionStart).split("\n").length;
    else while (at > 0 && !lines[at - 1].trim()) at--;
    lines.splice(at, 0, r.line);
    editor.value = lines.join("\n");
    markDirty();
    await save();
    if (mode === "view") render();
    window.dispatchEvent(new Event("tasks-changed"));
    toast(r.due ? `Задача добавлена на ${r.due}${r.time ? " " + r.time : ""}` : "Задача добавлена");
  };
  // checkboxes in the rendered note toggle the task in the file
  view.addEventListener("change", async (e) => {
    const box = e.target as HTMLInputElement;
    if (box.type !== "checkbox") return;
    const idx = [...view.querySelectorAll("input[type=checkbox]")].indexOf(box);
    const ln = taskLines()[idx];
    if (ln === undefined) return;
    const lines = editor.value.split("\n");
    lines[ln] = box.checked
      ? lines[ln].replace(/\[ \]/, "[x]").replace(/\s*✅ \d{4}-\d{2}-\d{2}/, "") + ` ✅ ${ymd(new Date())}`
      : lines[ln].replace(/\[[xX]\]/, "[ ]").replace(/\s*✅ \d{4}-\d{2}-\d{2}/, "");
    editor.value = lines.join("\n");
    markDirty();
    await save();
    window.dispatchEvent(new Event("tasks-changed"));
  });

  function render() {
    // the front matter (tags: …) is shown as chips above the note, not as text
    const body = editor.value.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    view.innerHTML = DOMPurify.sanitize(marked.parse(wikilinks(body), { async: false }) as string);
    // task checkboxes are clickable here (marked renders them disabled)
    view.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((b) => { b.disabled = false; b.closest("li")?.classList.add("task-li"); });
  }

  function setMode(m: "edit" | "view") {
    mode = m;
    localStorage.setItem("opsdeck.notes.mode", m);
    root.querySelectorAll<HTMLElement>("[data-m]").forEach((b) => b.classList.toggle("active", b.dataset.m === m));
    if (current === null) return;
    editor.hidden = m !== "edit";
    view.hidden = m !== "view";
    if (m === "view") render(); else editor.focus();
  }

  async function save() {
    if (!current || !dirty()) return;
    try {
      await invoke("note_write", { path: current, content: withEol(editor.value, eol) });
      saved = editor.value;
      markDirty();
      toast("Сохранено");
    } catch (e) { toast(String(e), "err"); }
  }

  listEl.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".note-item");
    if (b) openNote(b.dataset.p!);
  };
  view.onclick = (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#note:") && vault) {
      const target = decodeURIComponent(href.slice(6)).toLowerCase();
      const hit = vault.notes.find((n) => n.path.toLowerCase().replace(/\.md$/, "") === target)
        ?? vault.notes.find((n) => n.path.split("/").pop()!.toLowerCase().replace(/\.md$/, "") === target.split("/").pop());
      hit ? openNote(hit.path) : toast(`Заметка «${target}» не найдена`, "err");
    }
  };
  editor.addEventListener("input", markDirty);
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Tab") { e.preventDefault(); editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end"); markDirty(); }
  });
  root.addEventListener("keydown", (e) => {
    // by the physical key: e.key is "ы"/"у" in the Russian layout
    if (e.ctrlKey && e.code === "KeyS") { e.preventDefault(); save(); }
    if (e.ctrlKey && e.code === "KeyE" && current) { e.preventDefault(); setMode(mode === "edit" ? "view" : "edit"); }
  });
  root.querySelectorAll<HTMLElement>("[data-m]").forEach((b) => (b.onclick = () => setMode(b.dataset.m as "edit" | "view")));
  saveBtn.onclick = save;
  $("[data-a=obsidian]").onclick = () => current && invoke("note_open_obsidian", { path: current }).catch((e) => toast(String(e), "err"));
  $("[data-a=reload]").onclick = loadVault;

  // ----- Claude Code IDE bridge -----
  const fullPath = (rel: string) => `${vault?.root ?? ""}/${rel}`;
  const lineCol = (text: string, offset: number) => {
    const before = text.slice(0, offset);
    const line = before.split("\n").length - 1;
    return { line, character: offset - (before.lastIndexOf("\n") + 1) };
  };
  let selTimer = 0;
  document.addEventListener("selectionchange", () => {
    if (document.activeElement !== editor || !current) return;
    clearTimeout(selTimer);
    selTimer = window.setTimeout(() => {
      const { selectionStart: a, selectionEnd: b, value } = editor;
      const fp = fullPath(current!);
      invoke("ide_selection", { selection: {
        text: value.slice(a, b), filePath: fp, fileUrl: `file://${fp}`,
        selection: { start: lineCol(value, a), end: lineCol(value, b), isEmpty: a === b },
      } }).catch(() => {});
    }, 250);
  });
  // "@ <agent>": the default AI agent (Settings → AI agent)
  const mentionBtn = $<HTMLButtonElement>("[data-a=mention]");
  const syncMention = () => {
    const agent = aiAgent();
    mentionBtn.textContent = `@ ${agent}`;
    mentionBtn.title = `${i18nT("Вставить ссылку на заметку (или выделенные строки) в запрос")} ${agent}`;
  };
  syncMention();
  window.addEventListener("ai-agent", syncMention);
  mentionBtn.onclick = () => {
    if (!current) return;
    const { selectionStart: a, selectionEnd: b, value } = editor;
    const lines = !editor.hidden && a !== b ? { lineStart: lineCol(value, a).line, lineEnd: lineCol(value, b).line } : { lineStart: null, lineEnd: null };
    const path = fullPath(current);
    // other agents (and Claude without the IDE bridge): the reference goes into the AI panel's prompt
    const toPanel = () => {
      window.dispatchEvent(new CustomEvent("send-to-ai", { detail: fileRef(path, lines.lineStart, lines.lineEnd) + " " }));
      toast(`${i18nT("Ссылка на заметку отправлена в")} ${aiAgent()}`);
    };
    if (aiAgent() !== DEFAULT_AGENT) return toPanel();
    invoke("ide_at_mention", { filePath: path, ...lines })
      .then(() => toast("Ссылка на заметку вставлена в запрос Claude"), toPanel);
  };
  // Claude asked OpsDeck to open a file (openFile tool)
  listen<string>("ide-open-file", (e) => {
    const root = vault?.root;
    if (root && e.payload.startsWith(root + "/") && e.payload.endsWith(".md")) {
      window.dispatchEvent(new CustomEvent("show-view", { detail: "notes" }));
      openNote(e.payload.slice(root.length + 1));
    } else {
      toast(`Claude открыл ${e.payload} — OpsDeck показывает только заметки`, "err");
    }
  });
  registerProvider(() => (vault?.notes ?? []).map((n) => ({
    group: "Заметка", title: n.path.replace(/\.md$/, ""),
    run: () => { window.dispatchEvent(new CustomEvent("show-view", { detail: "notes" })); openNote(n.path); },
  })));
  $("[data-a=collapse]").onclick = () => { openDirs.clear(); saveOpen(); drawList(); };
  $("[data-a=daily]").onclick = async () => {
    try { const p = await invoke<string>("note_daily"); await loadVault(); openNote(p); } catch (e) { toast(String(e), "err"); }
  };
  /** folder "" = vault root; the name may still contain subfolders ("a/b/note"). */
  async function newNote(folder: string | null) {
    const name = folder === null
      ? await ask("Новая заметка", "Путь внутри vault (папки через /):", { input: lastFolder ? `${lastFolder}/` : "Inbox/", ok: "Создать" })
      : await ask("Новая заметка", `Имя заметки в папке «${folder || vault?.name || "/"}»:`, { input: "", ok: "Создать" });
    const clean = name?.trim().replace(/^\/+/, "");
    if (!clean || clean.endsWith("/")) return;
    const rel = folder ? `${folder}/${clean}` : clean;
    const path = rel.endsWith(".md") ? rel : `${rel}.md`;
    if (vault?.notes.some((n) => n.path === path)) { toast(`«${path}» уже есть — открываю её`); openNote(path); return; }
    try {
      await invoke("note_write", { path, content: `# ${path.split("/").pop()!.replace(/\.md$/, "")}\n\n` });
      await loadVault();
      mode = "edit";
      openNote(path);
    } catch (e) { toast(String(e), "err"); }
  }
  $("[data-a=new]").onclick = () => newNote(null);

  // ----- drag notes and folders between folders (pointer events: HTML5 DnD is unreliable in the webview) -----
  const parentOf = (p: string) => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  const baseOf = (p: string) => p.split("/").pop()!;
  let dragJustEnded = false;
  listEl.addEventListener("click", (e) => { if (dragJustEnded) { e.stopPropagation(); e.preventDefault(); } }, true);
  listEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || q.value.trim().length >= 2) return;
    const t = e.target as HTMLElement;
    if (t.closest(".tree-add")) return;
    const note = t.closest<HTMLElement>(".note-item:not(.hit)");
    const row = t.closest<HTMLElement>(".tree-row");
    const src = note ? { path: note.dataset.p!, dir: false }
      : row?.parentElement?.dataset.dir !== undefined ? { path: row!.parentElement!.dataset.dir!, dir: true } : null;
    if (!src) return;
    const x0 = e.clientX, y0 = e.clientY;
    let ghost: HTMLElement | null = null;
    let target: string | null = null;
    let hoverDir: HTMLElement | null = null, hoverTimer = 0;
    const valid = (dst: string | null) => dst !== null && dst !== parentOf(src.path)
      && !(src.dir && (dst === src.path || dst.startsWith(src.path + "/")));
    const mark = (dst: string | null) => {
      listEl.querySelectorAll(".drop-target").forEach((x) => x.classList.remove("drop-target"));
      listEl.classList.toggle("drop-root", dst === "");
      if (dst) listEl.querySelector(`.tree-dir[data-dir="${CSS.escape(dst)}"] > .tree-row`)?.classList.add("drop-target");
    };
    const move = (ev: PointerEvent) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
        ghost = document.createElement("div");
        ghost.className = "drag-ghost";
        ghost.textContent = (src.dir ? "📁 " : "📄 ") + baseOf(src.path).replace(/\.md$/, "");
        document.body.appendChild(ghost);
      }
      ghost.style.left = `${ev.clientX + 12}px`;
      ghost.style.top = `${ev.clientY + 8}px`;
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      let dst: string | null = null;
      let dirEl: HTMLElement | null = null;
      if (el && listEl.contains(el) && !el.closest("[data-section]")) {
        const r = el.closest<HTMLElement>(".tree-row");
        const n = el.closest<HTMLElement>(".note-item");
        if (r?.parentElement?.dataset.dir !== undefined) { dirEl = r!.parentElement!; dst = dirEl.dataset.dir!; }
        else if (n) dst = parentOf(n.dataset.p!);
        else dst = "";
      }
      // hovering a closed folder for a moment opens it
      if (dirEl !== hoverDir) {
        clearTimeout(hoverTimer);
        hoverDir = dirEl;
        if (dirEl && !dirEl.classList.contains("open")) {
          const d = dirEl;
          hoverTimer = window.setTimeout(() => d.querySelector<HTMLElement>(":scope > .tree-row")?.click(), 700);
        }
      }
      target = valid(dst) ? dst : null;
      mark(target);
    };
    const up = async () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      clearTimeout(hoverTimer);
      if (!ghost) return;
      ghost.remove();
      mark(null);
      dragJustEnded = true;
      setTimeout(() => { dragJustEnded = false; }, 0);
      if (target === null) return;
      const dest = (target ? `${target}/` : "") + baseOf(src.path);
      try {
        await invoke("note_move", { from: src.path, to: dest });
        // keep the open note and the expanded folders pointing at the new place
        if (current === src.path) current = dest;
        else if (src.dir && current?.startsWith(src.path + "/")) current = dest + current.slice(src.path.length);
        if (current) $(".note-path").textContent = current.replace(/\.md$/, "");
        if (src.dir) for (const d of [...openDirs]) if (d === src.path || d.startsWith(src.path + "/")) { openDirs.delete(d); openDirs.add(dest + d.slice(src.path.length)); }
        if (target) reveal(`${target}/x`);
        saveOpen();
        await loadVault();
        toast(`Перемещено в «${target || vault?.name || "/"}»`);
      } catch (err) { toast(String(err), "err"); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  // ----- context menu on notes and folders: new note here / rename / delete -----
  function popup(rect: { left: number; top: number; bottom: number }, items: [string, () => void, boolean?][]) {
    document.querySelector(".ctx-menu")?.remove();
    const m = document.createElement("div");
    m.className = "ctx-menu";
    m.innerHTML = items.map(([label, , danger], i) => `<div class="ctx-item ${danger ? "danger" : ""}" data-i="${i}">${esc(label)}</div>`).join("");
    document.body.appendChild(m);
    const x = Math.min(rect.left, window.innerWidth - m.offsetWidth - 8);
    const y = rect.bottom + m.offsetHeight > window.innerHeight ? rect.top - m.offsetHeight : rect.bottom;
    m.style.left = `${x}px`;
    m.style.top = `${Math.max(4, y)}px`;
    m.onclick = (e) => { const i = (e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i; m.remove(); if (i !== undefined) items[Number(i)][1](); };
    setTimeout(() => document.addEventListener("click", () => m.remove(), { once: true }), 0);
  }

  function itemMenu(el: HTMLElement, rect: { left: number; top: number; bottom: number }) {
    const note = el.classList.contains("note-item") ? el.dataset.p! : null;
    const dir = note ? null : el.parentElement?.dataset.dir ?? null;
    const path = note ?? dir;
    if (path === null) return;
    const items: [string, () => void, boolean?][] = [];
    if (dir !== null) items.push(["＋ Новая заметка здесь", () => newNote(dir)]);
    if (note) items.push(["Открыть", () => openNote(note)]);
    items.push(["Переименовать…", () => renameItem(path, !!note)]);
    items.push([note ? "Удалить заметку" : "Удалить папку", () => deleteItem(path, !!note), true]);
    popup(rect, items);
  }
  listEl.addEventListener("contextmenu", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".note-item:not(.hit), .tree-dir[data-dir] > .tree-row");
    if (!el) return;
    e.preventDefault();
    itemMenu(el, { left: e.clientX, top: e.clientY, bottom: e.clientY });
  });

  async function renameItem(path: string, isNote: boolean) {
    const old = path.split("/").pop()!.replace(/\.md$/, "");
    const name = (await ask("Переименовать", isNote ? "Новое имя заметки:" : "Новое имя папки:", { input: old, ok: "Переименовать" }))?.trim().replace(/\//g, "-");
    if (!name || name === old) return;
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    const dest = parent + name + (isNote ? ".md" : "");
    try {
      await invoke("note_move", { from: path, to: dest });
      if (current === path) current = dest;
      else if (!isNote && current?.startsWith(path + "/")) current = dest + current.slice(path.length);
      if (current) $(".note-path").textContent = current.replace(/\.md$/, "");
      await loadVault();
    } catch (e) { toast(String(e), "err"); }
  }

  async function deleteItem(path: string, isNote: boolean) {
    const count = isNote ? 0 : (vault?.notes.filter((n) => n.path.startsWith(path + "/")).length ?? 0);
    const msg = isNote
      ? `Удалить заметку «${path.replace(/\.md$/, "")}»? Она переедет в корзину хранилища (.trash) — оттуда её можно вернуть.`
      : `Удалить папку «${path}»${count ? ` и ${count} заметок в ней` : ""}? Всё переедет в корзину хранилища (.trash).`;
    if ((await ask(isNote ? "Удалить заметку" : "Удалить папку", msg, { ok: "Удалить", danger: true })) === null) return;
    try {
      await invoke<string>("note_delete", { path });
      if (current && (current === path || current.startsWith(path + "/"))) {
        current = null;
        saved = editor.value = "";
        editor.hidden = view.hidden = true;
        $(".note-path").textContent = i18nT("выберите заметку");
        $(".note-path").classList.add("muted");
        $(".note-tags").hidden = true;
        ["obsidian", "mention", "task"].forEach((a) => ($<HTMLButtonElement>(`[data-a=${a}]`).disabled = true));
        markDirty();
      }
      toast("Перемещено в корзину хранилища (.trash)");
      await loadVault();
      window.dispatchEvent(new Event("tasks-changed"));
    } catch (e) { toast(String(e), "err"); }
  }

  // ----- vaults: switch / create / open a folder -----
  async function vaultMenu() {
    const box = $(".vault-menu");
    if (!box.hidden) { box.hidden = true; return; }
    const v = await invoke<{ active: string; vaults: VaultEntry[] }>("vaults_list").catch((e) => { toast(String(e), "err"); return null; });
    if (!v) return;
    box.hidden = false;
    box.innerHTML = `${v.vaults.map((x) => `
      <div class="vault-item ${x.path === v.active ? "active" : ""} ${x.exists ? "" : "missing"}" data-v="${esc(x.path)}" title="${esc(x.path)}">
        <span class="vault-mark">${x.path === v.active ? "●" : ""}</span><span class="tree-label">${esc(x.name)}</span>
        ${x.obsidian ? `<span class="vault-badge">Obsidian</span>` : ""}${x.found ? `<span class="vault-badge found">найдено</span>` : ""}${x.exists ? "" : `<span class="vault-badge">нет папки</span>`}
        ${x.path !== v.active && !x.found ? `<span class="vault-x" data-forget="${esc(x.path)}" title="Убрать из списка (папка останется)">${icon("close", 14)}</span>` : ""}
      </div>`).join("")}
      <div class="vault-act" data-va="create">${icon("plus", 14)} Создать хранилище…</div>
      <div class="vault-act" data-va="open">${icon("folderOpen", 14)} Открыть папку как хранилище…</div>`;
  }
  $("[data-a=vaults]").onclick = vaultMenu;
  const switched = async () => {
    current = null;
    saved = editor.value = "";
    editor.hidden = view.hidden = true;
    $(".note-path").textContent = i18nT("выберите заметку");
    $(".note-tags").hidden = true;
    tagFilter = "";
    $(".vault-menu").hidden = true;
    window.dispatchEvent(new Event("settings-changed"));
    await loadVault();
    window.dispatchEvent(new Event("tasks-changed"));
  };
  $(".vault-menu").addEventListener("click", async (e) => {
    const el = e.target as HTMLElement;
    const forget = el.closest<HTMLElement>("[data-forget]")?.dataset.forget;
    if (forget) { await invoke("vault_forget", { path: forget }); $(".vault-menu").hidden = true; vaultMenu(); return; }
    const act = el.closest<HTMLElement>("[data-va]")?.dataset.va;
    if (dirty() && (act || el.closest("[data-v]")) && (await ask("Несохранённые изменения", `Изменения в «${current}» будут потеряны. Продолжить?`, { ok: "Не сохранять", danger: true })) === null) return;
    try {
      if (act === "create") {
        const name = await ask("Новое хранилище", "Название (так будет называться папка):", { input: "Заметки", ok: "Дальше" });
        if (!name?.trim()) return;
        toast("Выберите, где создать папку хранилища");
        // null = cancelled in the system dialog; undefined = no dialog available → type the path
        const picked = await invoke<string | null>("pick_folder", { start: null }).catch(() => undefined);
        if (picked === null) return;
        const parent = picked ?? await ask("Где создать", "Папка, внутри которой создать хранилище:", { input: "~/Documents", ok: "Создать" });
        if (!parent) return;
        await invoke("vault_create", { parent, name: name.trim() });
        toast(`Хранилище «${name.trim()}» создано`);
        return switched();
      }
      if (act === "open") {
        const picked = await invoke<string | null>("pick_folder", { start: null }).catch(() => undefined);
        if (picked === null) return;
        const dir = picked ?? await ask("Открыть хранилище", "Папка с заметками (.md) или Obsidian vault:", { input: "~/", ok: "Открыть" });
        if (!dir) return;
        await invoke("vault_open", { path: dir, name: null });
        return switched();
      }
      const path = el.closest<HTMLElement>("[data-v]")?.dataset.v;
      if (path) { await invoke("vault_activate", { path }); return switched(); }
    } catch (err) { toast(String(err), "err"); }
  });

  // opened from the task list / reminders
  window.addEventListener("open-note", (e) => {
    const { path, line } = (e as CustomEvent<{ path: string; line?: number }>).detail;
    openNote(path, line);
  });
  let tagTimer = 0;
  editor.addEventListener("input", () => { clearTimeout(tagTimer); tagTimer = window.setTimeout(drawNoteTags, 500); });

  let t = 0;
  q.oninput = () => { clearTimeout(t); t = window.setTimeout(drawList, 200); };

  setMode(mode);
  window.addEventListener("view-shown", (e) => { if ((e as CustomEvent).detail === "notes" && !vault) loadVault(); });
  window.addEventListener("settings-changed", loadVault);
  loadVault();
}
