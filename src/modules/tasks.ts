import { helpBtn } from "./help";
import { icon } from "./icons";
import { t as tl, locale } from "../i18n";
import { invoke } from "@tauri-apps/api/core";
import { esc, toast } from "./ui";
import { registerProvider } from "./palette";
import { addDays, openNote, PRIORITY, startReminderCards, taskDialog, ymd, type Task } from "./taskkit";

const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const PRIO_MARK: Record<number, string> = { 3: "↑↑", 2: "↑", 1: "↗", [-1]: "↓" };

const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const human = (d: string) => {
  const t = ymd(new Date());
  if (d === t) return tl("сегодня");
  if (d === ymd(addDays(new Date(), 1))) return tl("завтра");
  if (d === ymd(addDays(new Date(), -1))) return tl("вчера");
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(locale(), { day: "numeric", month: "short", ...(y !== new Date().getFullYear() ? { year: "numeric" } : {}) });
};

export function mountTasks(root: HTMLElement) {
  root.classList.add("tasks-view");
  root.innerHTML = `
    <div class="page tasks-page">
      <div class="page-head">
        <h2>Задачи <span class="muted small-note tk-count"></span></h2>
        <div class="row">
          <input class="tk-filter" placeholder="поиск: текст, #тег, заметка" spellcheck="false" />
          <button class="ghost" data-a="cal" title="Календарь: какие задачи на какой день">${icon("calendar", 16)} Календарь</button>
          <button class="primary" data-a="add">${icon("plus", 16)} Задача</button>
          ${helpBtn("tasks")}
        </div>
      </div>
      <div class="tk-cal" hidden></div>
      <div class="tk-tags"></div>
      <div class="tk-list"><p class="muted">загрузка…</p></div>
    </div>`;
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const listEl = $(".tk-list"), filter = $<HTMLInputElement>(".tk-filter"), cal = $(".tk-cal");
  let tasks: Task[] = [];
  let tagFilter = "";
  let calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let calDay = ymd(new Date());
  const closed = new Set<string>(JSON.parse(ls.get("opsdeck.tasks.closed") ?? '["done"]') as string[]);

  async function load() {
    try {
      tasks = await invoke<Task[]>("tasks_list");
    } catch (e) {
      listEl.innerHTML = `<p class="muted">${esc(e)}</p>`;
      tasks = [];
    }
    badge();
    draw();
    if (!cal.hidden) drawCal();
  }

  /** Overdue + today on the sidebar icon. */
  function badge() {
    const t = ymd(new Date());
    const n = tasks.filter((x) => !x.done && x.due && x.due <= t).length;
    const b = document.querySelector<HTMLElement>("#sidebar [data-view=tasks]");
    if (!b) return;
    b.dataset.badge = n > 99 ? "99+" : String(n);
    b.classList.toggle("has-badge", n > 0);
  }

  const matches = (t: Task) => {
    const q = filter.value.trim().toLowerCase();
    if (tagFilter && !t.tags.includes(tagFilter)) return false;
    return !q || `${t.text} ${t.path}`.toLowerCase().includes(q.replace(/^#/, ""));
  };

  function row(t: Task): string {
    const today = ymd(new Date());
    const overdue = !t.done && t.due && t.due < today;
    const text = esc(t.text).replace(/(^|\s)#([\p{L}\p{N}_\-/]+)/gu, (_m, s, tag) => `${s}<span class="tk-tag" data-tag="${tag}">#${tag}</span>`);
    return `<div class="tk-row ${t.done ? "done" : ""} ${overdue ? "overdue" : ""}" data-k="${esc(`${t.path}:${t.line}`)}">
      <input type="checkbox" class="tk-check" ${t.done ? "checked" : ""} title="${t.done ? "Вернуть в работу" : "Выполнено"}" />
      ${PRIO_MARK[t.priority] ? `<span class="tk-prio" title="${PRIORITY[String(t.priority)]}">${PRIO_MARK[t.priority]}</span>` : ""}
      <span class="tk-text">${text}</span>
      <span class="tk-meta">
        ${t.due ? `<span class="tk-due" data-act="due" title="Изменить срок">${icon("calendar", 14)} ${esc(human(t.due))}${t.time ? ` ${icon("clock", 14)} ${esc(t.time)}` : ""}</span>` : `<span class="tk-due empty" data-act="due" title="Назначить срок">${icon("plus", 14)} срок</span>`}
        <span class="tk-acts">
          ${!t.done ? `<span data-act="tomorrow" title="Перенести на завтра">→ завтра</span>` : ""}
          <span data-act="edit" title="Изменить задачу">${icon("edit", 14)}</span>
        </span>
        <span class="tk-note" data-act="open" title="Открыть заметку">${esc(t.path.replace(/\.md$/, ""))}</span>
      </span>
    </div>`;
  }

  function draw() {
    const today = ymd(new Date()), tomorrow = ymd(addDays(new Date(), 1)), week = ymd(addDays(new Date(), 7));
    const shown = tasks.filter(matches);
    const open = shown.filter((t) => !t.done);
    const sort = (a: Task, b: Task) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.time ?? "99").localeCompare(b.time ?? "99") || b.priority - a.priority;
    const groups: [string, string, Task[]][] = [
      ["overdue", "Просрочено", open.filter((t) => t.due && t.due < today)],
      ["today", "Сегодня", open.filter((t) => t.due === today)],
      ["tomorrow", "Завтра", open.filter((t) => t.due === tomorrow)],
      ["week", "На неделе", open.filter((t) => t.due && t.due > tomorrow && t.due <= week)],
      ["later", "Позже", open.filter((t) => t.due && t.due > week)],
      ["nodate", "Без срока", open.filter((t) => !t.due).sort((a, b) => b.priority - a.priority)],
      ["done", "Выполнено (14 дней)", shown.filter((t) => t.done && (!t.done_date || t.done_date >= ymd(addDays(new Date(), -14)))).sort((a, b) => (b.done_date ?? "").localeCompare(a.done_date ?? ""))],
    ];
    $(".tk-count").textContent = `${open.length} открытых`;
    // tag chips across all open tasks
    const tagCount = new Map<string, number>();
    tasks.filter((t) => !t.done).forEach((t) => t.tags.forEach((g) => tagCount.set(g, (tagCount.get(g) ?? 0) + 1)));
    $(".tk-tags").innerHTML = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) =>
      `<span class="tk-chip ${tagFilter === g ? "on" : ""}" data-tag="${esc(g)}">#${esc(g)} <b>${n}</b></span>`).join("");
    if (!tasks.length) {
      listEl.innerHTML = `<div class="tk-empty"><p>Задач пока нет.</p><p class="muted">Нажмите <b>＋ Задача</b> или в любой заметке — кнопку <b>＋ Задача</b>. Задачи — это строки <code>- [ ] …</code> в заметках, так что их видно и в Obsidian.</p></div>`;
      return;
    }
    listEl.innerHTML = groups.filter(([id, , ts]) => ts.length || id === "today").map(([id, title, ts]) => `
      <section class="tk-group ${closed.has(id) ? "closed" : ""} tk-${id}" data-g="${id}">
        <h3 class="tk-gh"><span class="tree-caret">▸</span>${title} <span class="muted">${ts.length}</span></h3>
        <div class="tk-items">${ts.length ? (id === "nodate" || id === "done" ? ts : ts.sort(sort)).map(row).join("") : `<p class="muted tk-none">на сегодня ничего — ＋ Задача</p>`}</div>
      </section>`).join("");
  }

  const find = (el: HTMLElement) => {
    const k = el.closest<HTMLElement>(".tk-row")?.dataset.k;
    return tasks.find((t) => `${t.path}:${t.line}` === k);
  };
  async function update(t: Task, change: Record<string, unknown>, msg?: string) {
    try {
      await invoke("task_update", { path: t.path, line: t.line, raw: t.raw, change });
      if (msg) toast(msg);
    } catch (e) { toast(String(e), "err"); }
    load();
  }

  async function editTask(t: Task) {
    const all = [...new Set(tasks.flatMap((x) => x.tags))];
    const textNoTags = t.text.replace(/(^|\s)#[\p{L}\p{N}_\-/]+/gu, "").trim();
    const r = await taskDialog({ title: "Задача", text: textNoTags, due: t.due, time: t.time, priority: t.priority, tags: t.tags, allTags: all, ok: "Сохранить" });
    if (!r) return;
    const tags = t.tags.length || r.line.includes("#") ? (r.line.match(/(?:^|\s)#[\p{L}\p{N}_\-/]+/gu) ?? []).map((s) => s.trim()).join(" ") : "";
    update(t, { text: `${r.text}${tags ? " " + tags : ""}`, due: r.due, time: r.time, priority: r.priority });
  }

  async function datePrompt(t: Task, anchor: HTMLElement) {
    // a native date input right where the user clicked
    const input = document.createElement("input");
    input.type = "date";
    input.value = t.due ?? ymd(new Date());
    input.className = "tk-date-pop";
    anchor.replaceWith(input);
    input.focus();
    input.showPicker?.();
    const done = (save: boolean) => {
      if (save && input.value !== (t.due ?? "")) update(t, { due: input.value }, input.value ? `Срок: ${human(input.value)}` : "Срок снят");
      else draw();
    };
    input.onchange = () => done(true);
    input.onblur = () => done(true);
    input.onkeydown = (e) => { if (e.key === "Escape") done(false); if (e.key === "Enter") done(true); };
  }

  listEl.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    const gh = el.closest<HTMLElement>(".tk-gh");
    if (gh) {
      const g = gh.parentElement as HTMLElement;
      g.classList.toggle("closed");
      g.classList.contains("closed") ? closed.add(g.dataset.g!) : closed.delete(g.dataset.g!);
      ls.set("opsdeck.tasks.closed", JSON.stringify([...closed]));
      return;
    }
    const tag = el.closest<HTMLElement>(".tk-tag")?.dataset.tag;
    if (tag) { tagFilter = tagFilter === tag ? "" : tag; draw(); return; }
    const t = find(el);
    if (!t) return;
    if (el.classList.contains("tk-check")) return update(t, { done: (el as HTMLInputElement).checked }, (el as HTMLInputElement).checked ? `Готово: ${t.text}` : undefined);
    const act = el.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "open") openNote(t.path, t.line);
    if (act === "tomorrow") update(t, { due: ymd(addDays(new Date(), 1)) }, "Перенесено на завтра");
    if (act === "edit") editTask(t);
    if (act === "due") datePrompt(t, el.closest<HTMLElement>("[data-act]")!);
  });
  listEl.addEventListener("dblclick", (e) => {
    const t = find(e.target as HTMLElement);
    if (t && (e.target as HTMLElement).closest(".tk-text")) editTask(t);
  });
  $(".tk-tags").addEventListener("click", (e) => {
    const g = (e.target as HTMLElement).closest<HTMLElement>("[data-tag]")?.dataset.tag;
    if (g) { tagFilter = tagFilter === g ? "" : g; draw(); }
  });
  let ft = 0;
  filter.oninput = () => { clearTimeout(ft); ft = window.setTimeout(draw, 150); };

  async function addTask(due?: string) {
    const all = [...new Set(tasks.flatMap((x) => x.tags))];
    const notes = [...new Set(tasks.map((t) => t.path))].filter((p) => p !== "Задачи.md").slice(0, 30);
    const r = await taskDialog({ due: due ?? ymd(new Date()), allTags: all, targets: [{ value: "Задачи.md", label: "Задачи.md (общий список)" }, ...notes.map((p) => ({ value: p, label: p.replace(/\.md$/, "") }))] });
    if (!r) return;
    try {
      await invoke("task_add", { path: r.target || null, line: r.line });
      toast("Задача добавлена");
      load();
    } catch (e) { toast(String(e), "err"); }
  }
  $("[data-a=add]").onclick = () => addTask();

  // ----- calendar: a month, tasks per day; click a day to see its list -----
  function drawCal() {
    const y = calMonth.getFullYear(), m = calMonth.getMonth();
    const first = new Date(y, m, 1);
    const start = addDays(first, -((first.getDay() + 6) % 7)); // Monday
    const today = ymd(new Date());
    const byDay = new Map<string, Task[]>();
    tasks.filter((t) => t.due && (!t.done || t.done_date)).forEach((t) => byDay.set(t.due!, [...(byDay.get(t.due!) ?? []), t]));
    const cells: string[] = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i), k = ymd(d), ts = byDay.get(k) ?? [];
      const open = ts.filter((t) => !t.done);
      cells.push(`<div class="cal-day ${d.getMonth() !== m ? "other" : ""} ${k === today ? "today" : ""} ${k === calDay ? "sel" : ""} ${open.length && k < today ? "late" : ""}" data-day="${k}">
        <span class="cal-n">${d.getDate()}</span>
        ${ts.slice(0, 3).map((t) => `<span class="cal-t ${t.done ? "done" : ""}">${esc(t.text.replace(/(^|\s)#\S+/g, "").trim())}</span>`).join("")}
        ${ts.length > 3 ? `<span class="cal-more">+${ts.length - 3}</span>` : ""}
      </div>`);
    }
    const dayTasks = (byDay.get(calDay) ?? []).sort((a, b) => (a.time ?? "99").localeCompare(b.time ?? "99"));
    cal.innerHTML = `
      <div class="cal-head"><button class="icon" data-c="prev">‹</button><b>${MONTHS[m]} ${y}</b><button class="icon" data-c="next">›</button>
        <button class="ghost" data-c="today">Сегодня</button><span class="spacer"></span><button class="icon" data-c="close" title="Закрыть">${icon("close", 16)}</button></div>
      <div class="cal-grid">${WD.map((w) => `<div class="cal-wd">${w}</div>`).join("")}${cells.join("")}</div>
      <div class="cal-dayhead"><b>${esc(human(calDay))}</b> <span class="muted">${calDay}</span><span class="spacer"></span><button class="ghost" data-c="add">${icon("plus", 14)} задача на этот день</button></div>
      <div class="cal-daylist">${dayTasks.length ? dayTasks.map(row).join("") : `<p class="muted">задач нет</p>`}</div>`;
  }
  cal.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    const c = el.closest<HTMLElement>("[data-c]")?.dataset.c;
    if (c === "prev") calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1);
    if (c === "next") calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1);
    if (c === "today") { calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1); calDay = ymd(new Date()); }
    if (c === "close") { cal.hidden = true; return; }
    if (c === "add") return void addTask(calDay);
    const day = el.closest<HTMLElement>("[data-day]")?.dataset.day;
    if (day) calDay = day;
    // rows inside the day list behave like the main list
    const t = find(el);
    if (t) {
      if (el.classList.contains("tk-check")) return void update(t, { done: (el as HTMLInputElement).checked });
      if (el.closest("[data-act=open]")) return openNote(t.path, t.line);
    }
    if (c || day) drawCal();
  });
  $("[data-a=cal]").onclick = () => { cal.hidden = !cal.hidden; if (!cal.hidden) drawCal(); };

  window.addEventListener("tasks-changed", load);
  window.addEventListener("settings-changed", load);
  window.addEventListener("view-shown", (e) => { if ((e as CustomEvent).detail === "tasks") load(); });
  // the badge stays fresh even when the view is closed
  setInterval(() => { if (!root.hidden) load(); else invoke<Task[]>("tasks_list").then((t) => { tasks = t; badge(); }).catch(() => {}); }, 60_000);
  registerProvider(() => [
    { group: "Задачи", title: "Новая задача", run: () => { window.dispatchEvent(new CustomEvent("show-view", { detail: "tasks" })); addTask(); } },
    { group: "Задачи", title: "Календарь задач", run: () => { window.dispatchEvent(new CustomEvent("show-view", { detail: "tasks" })); cal.hidden = false; drawCal(); } },
    ...tasks.filter((t) => !t.done).slice(0, 50).map((t) => ({ group: "Задача", title: t.text, hint: t.due ? human(t.due) : "", run: () => openNote(t.path, t.line) })),
  ]);
  startReminderCards();
  load();
}
