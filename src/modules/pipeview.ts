/** The pipeline graph in the IDE: a column per stage, a card per job, coloured by what would run. */
import { icon } from "./icons";
import { diffPlans, levels, plan, type Job, type Pipeline, type Planned, type RunCtx, type Status } from "./pipeline";
import { esc } from "./ui";

export type PipeView = {
  el: HTMLElement;
  /** Draw the pipeline; `branches` fills the branch list, `onOpen` opens the job where it is declared. */
  show(p: Pipeline, opts: { branches: string[]; defaultBranch: string; onOpen: (job: Job) => void; onAi: (text: string) => void }): void;
};

const STATUS_LABEL: Record<Status, string> = { run: "запустится", manual: "вручную", skip: "не запустится", unknown: "неизвестно" };
const EVENTS: [RunCtx["event"], string][] = [["push", "push в ветку"], ["merge_request", "merge request / PR"], ["tag", "тег"], ["schedule", "по расписанию"], ["manual", "запуск вручную"]];

/** Columns: the stages of GitLab, or the levels of the needs graph for GitHub. */
export function columns(p: Pipeline): { title: string; jobs: Job[] }[] {
  if (p.kind === "github") return levels(p.jobs).map((jobs, i) => ({ title: i === 0 ? "сразу" : `после ${i}`, jobs }));
  const order = new Map(p.stages.map((s, i) => [s, i]));
  const cols = p.stages.map((title) => ({ title, jobs: [] as Job[] }));
  for (const j of p.jobs) {
    const i = order.get(j.stage);
    if (i !== undefined) cols[i].jobs.push(j);
  }
  return cols.filter((c) => c.jobs.length);
}

export function mountPipeline(el: HTMLElement): PipeView {
  el.classList.add("pipe");
  el.innerHTML = `
    <div class="pipe-bar">
      <label class="inline">Событие <select class="pipe-event">${EVENTS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select></label>
      <label class="inline pipe-branch-l">Ветка <input class="pipe-branch" list="pipe-branches" spellcheck="false" /></label>
      <datalist id="pipe-branches"></datalist>
      <label class="inline pipe-tag-l" hidden>Тег <input class="pipe-tag" placeholder="v1.2.0" spellcheck="false" /></label>
      <label class="inline" title="Для rules:changes и on: paths — по одному пути в строке или через запятую; пусто = неизвестно">Изменены <input class="pipe-changes" placeholder="src/**, README.md" spellcheck="false" /></label>
      <label class="inline" title="Переменные проекта из файла не видны — задайте нужные вручную">Переменные <input class="pipe-vars" placeholder="DEPLOY=1, ENV=prod" spellcheck="false" /></label>
      <span class="spacer"></span>
      <label class="inline" title="Сравнить с другой веткой: что добавится или пропадёт"><input type="checkbox" class="pipe-cmp" /> сравнить с</label>
      <input class="pipe-branch2" list="pipe-branches" spellcheck="false" hidden />
    </div>
    <div class="pipe-sum"></div>
    <div class="pipe-graph"></div>
    <div class="pipe-note muted"></div>`;

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => el.querySelector<T>(s)!;
  const eventSel = $<HTMLSelectElement>(".pipe-event"), branchIn = $<HTMLInputElement>(".pipe-branch"), tagIn = $<HTMLInputElement>(".pipe-tag");
  const changesIn = $<HTMLInputElement>(".pipe-changes"), varsIn = $<HTMLInputElement>(".pipe-vars");
  const cmpCb = $<HTMLInputElement>(".pipe-cmp"), branch2 = $<HTMLInputElement>(".pipe-branch2");
  const graph = $(".pipe-graph"), sum = $(".pipe-sum"), note = $(".pipe-note");
  let pipeline: Pipeline | null = null;
  let opts: Parameters<PipeView["show"]>[1] | null = null;
  /** the job whose card is open: it survives a redraw and shows the new status */
  let openJob: string | null = null;

  const list = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  const vars = () => Object.fromEntries(list(varsIn.value).map((kv) => { const i = kv.indexOf("="); return i < 0 ? [kv, "true"] : [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]; }));
  const ctx = (branch: string): RunCtx => ({
    event: eventSel.value as RunCtx["event"],
    branch, tag: tagIn.value.trim() || undefined,
    changes: changesIn.value.trim() ? list(changesIn.value) : undefined,
    vars: vars(), defaultBranch: opts?.defaultBranch || "main",
  });

  function draw() {
    if (!pipeline || !opts) return;
    const p = pipeline;
    tagIn.closest("label")!.hidden = eventSel.value !== "tag";
    branchIn.closest("label")!.hidden = eventSel.value === "tag";
    branch2.hidden = !cmpCb.checked;
    const planned = plan(p, ctx(branchIn.value || opts.defaultBranch));
    const byName = new Map(planned.map((x) => [x.job.name, x]));
    const other = cmpCb.checked && branch2.value ? plan(p, ctx(branch2.value)) : null;
    const changed = other ? new Map(diffPlans(planned, other).map((d) => [d.name, d])) : null;

    const n = (s: Status) => planned.filter((x) => x.status === s).length;
    sum.innerHTML = [["run", "ok"], ["manual", "warn"], ["skip", "muted"], ["unknown", "warn"]]
      .filter(([s]) => n(s as Status))
      .map(([s, c]) => `<span class="${c}">${n(s as Status)} ${esc(STATUS_LABEL[s as Status])}</span>`).join(" · ")
      + (other ? ` <span class="muted">·</span> <b>${esc(branch2.value)}</b>: ${changed!.size ? `${changed!.size} отличий` : "так же"}` : "");

    graph.innerHTML = columns(p).map((col) => `
      <section class="pipe-col">
        <h4>${esc(col.title)}<span class="muted">${col.jobs.length}</span></h4>
        ${col.jobs.map((j) => {
          const pl = byName.get(j.name)!;
          const d = changed?.get(j.name);
          // a div, not a button: in Chromium a button does not grow to a second line and centres its content
          return `<div class="pipe-job ${pl.status}" role="button" tabindex="0" data-job="${esc(j.name)}" title="${esc(pl.reason || STATUS_LABEL[pl.status])}">
            <span class="pipe-name">${esc(j.name)}${j.parallel && j.parallel > 1 ? ` <span class="muted">×${j.parallel}</span>` : ""}</span>
            ${j.needs.length ? `<span class="pipe-needs muted">← ${esc(j.needs.join(", "))}</span>` : ""}
            ${j.trigger ? `<span class="pipe-needs muted">⇢ ${esc(j.trigger)}</span>` : ""}
            ${d ? `<span class="pipe-diff">${esc(STATUS_LABEL[d.from])} → ${esc(STATUS_LABEL[d.to])}</span>` : ""}
          </div>`;
        }).join("")}
      </section>`).join("") || `<p class="muted pad">В файле нет задач.</p>`;

    const notes: string[] = [];
    if (p.unresolved.length) notes.push(`не раскрыты include: ${p.unresolved.join(", ")} — их задачи не показаны`);
    if (p.errors.length) notes.push(p.errors.join("; "));
    if (n("unknown")) notes.push("«неизвестно» — условие зависит от того, чего нет в файле (переменные проекта, список изменений, exists:)");
    notes.push("это разбор файла, а не сам сервер: переменные проекта, защищённые ветки и дочерние пайплайны здесь не видны");
    note.textContent = notes.join(" · ");

    graph.querySelectorAll<HTMLElement>(".pipe-job").forEach((b) => {
      const open = () => {
        const job = p.jobs.find((j) => j.name === b.dataset.job);
        if (job) { openJob = job.name; showJob(job, byName.get(job.name)!); }
      };
      b.onclick = open;
      b.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
    });
    const still = openJob && p.jobs.find((j) => j.name === openJob);
    if (still) showJob(still, byName.get(still.name)!); else el.querySelector(".pipe-detail")?.remove();
  }

  function showJob(job: Job, pl: Planned) {
    const old = el.querySelector(".pipe-detail");
    old?.remove();
    const box = document.createElement("div");
    box.className = "pipe-detail";
    box.innerHTML = `
      <div class="row"><b>${esc(job.name)}</b><span class="pipe-chip ${pl.status}">${esc(STATUS_LABEL[pl.status])}</span><span class="spacer"></span>
        <button class="ghost" data-a="open">${icon("code", 14)} В файле</button>
        <button class="ghost" data-a="ai">⇢ AI</button>
        <button class="icon" data-a="close">${icon("close", 14)}</button></div>
      <div class="muted">${esc(job.file)}:${job.line}${job.stage ? ` · стадия ${esc(job.stage)}` : ""}${job.image ? ` · ${esc(job.image)}` : ""}${job.extendsFrom.length ? ` · extends ${esc(job.extendsFrom.join(", "))}` : ""}</div>
      <div>${esc(pl.reason || "без условий — запускается всегда")}</div>
      ${job.needs.length ? `<div class="muted">ждёт: ${esc(job.needs.join(", "))}</div>` : job.needsDeclared ? `<div class="muted">needs: [] — стартует сразу</div>` : ""}`;
    box.querySelector<HTMLElement>("[data-a=close]")!.onclick = () => { openJob = null; box.remove(); };
    box.querySelector<HTMLElement>("[data-a=open]")!.onclick = () => opts?.onOpen(job);
    box.querySelector<HTMLElement>("[data-a=ai]")!.onclick = () => opts?.onAi(
      `Задача «${job.name}» из ${job.file} (${pipeline?.kind === "github" ? "GitHub Actions" : "GitLab CI"}), стадия ${job.stage || "—"}.\n` +
      `Для события «${eventSel.value}» и ветки «${branchIn.value}» она ${STATUS_LABEL[pl.status]}: ${pl.reason}.\n\nОбъясни условие и как его изменить, чтобы задача вела себя иначе.`);
    el.insertBefore(box, note);
  }

  // Always redraw a moment later, never straight away: leaving a field fires `change` on mousedown, and a
  // graph rebuilt between mousedown and mouseup would swallow the click on a job card.
  let timer = 0;
  const redraw = () => { clearTimeout(timer); timer = window.setTimeout(draw, 120); };
  for (const c of [eventSel, branchIn, tagIn, changesIn, varsIn, cmpCb, branch2]) {
    c.addEventListener("change", redraw);
    c.addEventListener("input", redraw);
  }

  return {
    el,
    show(p, o) {
      pipeline = p;
      opts = o;
      $("#pipe-branches").innerHTML = o.branches.map((b) => `<option value="${esc(b)}"></option>`).join("");
      if (!branchIn.value) branchIn.value = o.branches[0] ?? o.defaultBranch;
      if (!branch2.value) branch2.value = o.defaultBranch;
      openJob = null;
      el.querySelector(".pipe-detail")?.remove();
      draw();
    },
  };
}
