/** Shared bits for notes and the task list: the "new task" dialog, tag parsing, reminder cards. */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { esc, overlay, toast } from "./ui";

export type Task = {
  path: string; line: number; raw: string; text: string; done: boolean;
  due: string | null; time: string | null; priority: number; tags: string[]; done_date: string | null;
  /** line of the parent task in the same note (a subtask), and the lines indented under the task */
  parent?: number | null; desc?: string;
};

export const PRIORITY: Record<string, string> = { "0": "обычный", "1": "🔼 повыше", "2": "⏫ высокий", "3": "🔺 срочно", "-1": "🔽 низкий" };

export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/** `#tag` in text (not code, not headings, not numbers) + front matter `tags:`; same rules as the backend. */
export function tagsOf(text: string): { all: string[]; front: string[] } {
  const all: string[] = [], front: string[] = [];
  const push = (t: string, fm = false) => {
    t = t.trim().replace(/^#/, "").replace(/^["']|["']$/g, "").trim();
    if (!t || /^\d+$/.test(t)) return;
    if (!all.includes(t)) all.push(t);
    if (fm && !front.includes(t)) front.push(t);
  };
  const lines = text.split("\n");
  let i = 0;
  if (lines[0]?.trim() === "---") {
    let inTags = false;
    for (i = 1; i < lines.length && lines[i].trim() !== "---"; i++) {
      const l = lines[i];
      const m = /^tags?:(.*)$/.exec(l);
      if (m) {
        inTags = !m[1].trim();
        m[1].trim().replace(/^\[|\]$/g, "").split(",").forEach((t) => push(t, true));
      } else if (inTags && /^\s*-\s/.test(l)) push(l.replace(/^\s*-\s/, ""), true);
      else inTags = false;
    }
    i++;
  }
  let fence = false;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.trimStart().startsWith("```")) { fence = !fence; continue; }
    if (fence) continue;
    const noCode = l.replace(/`[^`]*`/g, "");
    for (const m of noCode.matchAll(/(^|[\s(])#([\p{L}\p{N}_\-/]+)/gu)) push(m[2]);
  }
  return { all, front };
}

/** Set the front matter `tags:` list (creates the front matter if needed). */
export function setFrontTags(text: string, tags: string[]): string {
  const line = `tags: [${tags.join(", ")}]`;
  const lines = text.split("\n");
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) {
      // drop the old tags (inline or list form), put the new line first
      const body: string[] = [];
      let skipList = false;
      for (const l of lines.slice(1, end)) {
        if (/^tags?:/.test(l)) { skipList = !l.replace(/^tags?:/, "").trim(); continue; }
        if (skipList && /^\s*-\s/.test(l)) continue;
        skipList = false;
        body.push(l);
      }
      const fm = tags.length ? [line, ...body] : body;
      return (fm.length ? ["---", ...fm, "---"] : []).concat(lines.slice(end + 1)).join("\n");
    }
  }
  return tags.length ? `---\n${line}\n---\n${text}` : text;
}

/** Modal for a new (or edited) task. Resolves to the task line, or null. */
export function taskDialog(opts: {
  title?: string; text?: string; due?: string | null; time?: string | null; priority?: number; tags?: string[];
  allTags?: string[]; targets?: { value: string; label: string }[]; ok?: string;
  /** показать поле «Описание» (раздел «Задачи»; в заметке описание пишется прямо под строкой) */
  desc?: string | null;
} = {}): Promise<{ line: string; target: string; text: string; due: string; time: string; priority: number; desc: string } | null> {
  const dlg = document.createElement("dialog");
  dlg.className = "task-dialog";
  const today = new Date();
  const quick: [string, string][] = [["Сегодня", ymd(today)], ["Завтра", ymd(addDays(today, 1))], ["Через неделю", ymd(addDays(today, 7))], ["Без срока", ""]];
  dlg.innerHTML = `
    <form method="dialog">
      <h3>${esc(opts.title ?? "Новая задача")}</h3>
      <label>Что сделать <input name="text" required value="${esc(opts.text ?? "")}" placeholder="Обновить сертификат на ingress" autocomplete="off" /></label>
      <div class="td-quick">${quick.map(([l, v]) => `<button type="button" data-d="${v}">${l}</button>`).join("")}</div>
      <div class="grid2">
        <label>Срок <input name="due" type="date" value="${esc(opts.due ?? "")}" /></label>
        <label>Напомнить в <input name="time" type="time" value="${esc(opts.time ?? "")}" /></label>
      </div>
      <div class="grid2">
        <label>Приоритет <select name="priority">${Object.entries(PRIORITY).map(([k, v]) => `<option value="${k}" ${String(opts.priority ?? 0) === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <label>Теги <input name="tags" list="td-tags" value="${esc((opts.tags ?? []).join(" "))}" placeholder="infra срочно" autocomplete="off" /></label>
      </div>
      ${opts.desc != null ? `<label>Описание <textarea name="desc" rows="4" spellcheck="false" placeholder="Подробности: что и где сделать, ссылки, команды. Записывается строками с отступом под задачей">${esc(opts.desc)}</textarea></label>` : ""}
      <datalist id="td-tags">${(opts.allTags ?? []).map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
      ${opts.targets?.length ? `<label>Куда записать <select name="target">${opts.targets.map((t) => `<option value="${esc(t.value)}">${esc(t.label)}</option>`).join("")}</select></label>` : ""}
      <p class="muted hint">Напоминание всплывёт в указанное время срока, пока OpsDeck запущен. Задача записывается строкой в заметку и видна в Obsidian.</p>
      <p class="err form-err"></p>
      <div class="actions"><button value="cancel" formnovalidate>Отмена</button><button value="ok" class="primary">${esc(opts.ok ?? "Добавить")}</button></div>
    </form>`;
  document.body.appendChild(dlg);
  overlay(true);
  const f = (n: string) => dlg.querySelector<HTMLInputElement & HTMLSelectElement>(`[name=${n}]`)!;
  const syncTime = () => { f("time").disabled = !f("due").value; };
  f("due").oninput = syncTime;
  syncTime();
  dlg.querySelectorAll<HTMLElement>("[data-d]").forEach((b) => (b.onclick = () => { f("due").value = b.dataset.d!; syncTime(); }));
  return new Promise((resolve) => {
    let result: Awaited<ReturnType<typeof taskDialog>> = null;
    dlg.querySelector("form")!.addEventListener("submit", async (e) => {
      if ((e.submitter as HTMLButtonElement | null)?.value !== "ok") return;
      e.preventDefault();
      const tags = f("tags").value.split(/[\s,]+/).map((t) => t.replace(/^#/, "")).filter(Boolean);
      try {
        const line = await invoke<string>("task_format", {
          text: f("text").value, due: f("due").value || null, time: f("due").value ? f("time").value || null : null,
          priority: Number(f("priority").value), tags,
        });
        result = { line, target: dlg.querySelector<HTMLSelectElement>("[name=target]")?.value ?? "", text: f("text").value.trim(), due: f("due").value, time: f("time").value, priority: Number(f("priority").value),
          desc: dlg.querySelector<HTMLTextAreaElement>("[name=desc]")?.value ?? "" };
        dlg.close("ok");
      } catch (err) { dlg.querySelector(".form-err")!.textContent = String(err); }
    });
    dlg.addEventListener("close", () => { overlay(false); dlg.remove(); resolve(result); });
    dlg.showModal();
    f("text").focus();
  });
}

/** Opens a note at a line in the notes view (handled by notes.ts). */
export const openNote = (path: string, line?: number) => {
  window.dispatchEvent(new CustomEvent("show-view", { detail: "notes" }));
  window.dispatchEvent(new CustomEvent("open-note", { detail: { path, line } }));
};

// ----- reminder cards: stay on screen until the user decides -----
let stack: HTMLElement | null = null;
export function startReminderCards() {
  listen<{ key: string; task: Task }>("task-reminder", (e) => {
    const { key, task } = e.payload;
    stack ??= Object.assign(document.createElement("div"), { className: "remind-stack" });
    if (!stack.isConnected) document.body.appendChild(stack);
    stack.querySelector(`[data-key="${CSS.escape(key)}"]`)?.remove();
    const card = document.createElement("div");
    card.className = "remind-card";
    card.dataset.key = key;
    card.innerHTML = `<div class="rc-head">⏰ ${esc(task.time ?? "")} <span class="muted">${esc(task.path.replace(/\.md$/, ""))}</span><button class="icon" data-r="close" title="Скрыть">×</button></div>
      <div class="rc-text">${esc(task.text)}</div>
      <div class="rc-acts">
        <button class="primary" data-r="done">✓ Готово</button>
        <select data-r="snooze"><option value="">Отложить…</option><option value="10">на 10 мин</option><option value="30">на 30 мин</option><option value="60">на час</option><option value="180">на 3 часа</option></select>
        <button class="ghost" data-r="open">Открыть</button>
      </div>`;
    card.addEventListener("click", async (ev) => {
      const r = (ev.target as HTMLElement).closest<HTMLElement>("[data-r]")?.dataset.r;
      if (r === "close") card.remove();
      if (r === "open") { openNote(task.path, task.line); card.remove(); }
      if (r === "done") {
        try {
          await invoke("task_update", { path: task.path, line: task.line, raw: task.raw, change: { done: true } });
          toast(`Готово: ${task.text}`);
          window.dispatchEvent(new Event("tasks-changed"));
          card.remove();
        } catch (err) { toast(String(err), "err"); }
      }
    });
    card.querySelector<HTMLSelectElement>("[data-r=snooze]")!.onchange = (ev) => {
      const m = Number((ev.target as HTMLSelectElement).value);
      if (!m) return;
      invoke("task_snooze", { key, minutes: m });
      toast(`Напомню через ${m >= 60 ? `${m / 60} ч` : `${m} мин`}`);
      card.remove();
    };
    stack.appendChild(card);
  });
}
