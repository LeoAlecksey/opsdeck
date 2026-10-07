/**
 * Monitoring board: CPU, load, memory, disk and uptime of chosen SSH hosts at a glance.
 * Each host is probed over ssh by key (never asks for a password) or over a session already open
 * in OpsDeck; the connection is kept for the next refresh. Linux hosts only (/proc).
 */
import { invoke } from "@tauri-apps/api/core";
import { helpBtn } from "./help";
import { icon } from "./icons";
import { esc } from "./ui";

type SshHost = { id: string; name: string; group: string; host: string; user: string };
type ConfigHost = { alias: string; group: string; hostname: string; user: string };
type Stats = {
  host: string; cpu: number | null; cores: number; load: [number, number, number] | null;
  mem_used: number; mem_total: number; swap_used: number; swap_total: number;
  disk_mount: string; disk_used: number; disk_total: number; uptime: number;
};
/** a host that can be put on the board */
export type Target = { key: string; name: string; group: string; addr: string };
type State = { stats?: Stats; error?: string; at?: number; busy?: boolean };

const KEY_HOSTS = "opsdeck.mon.hosts", KEY_EVERY = "opsdeck.mon.every";
const PARALLEL = 6;
const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

export const pct = (used: number, total: number) => (total ? (100 * used) / total : 0);
export const level = (p: number) => (p >= 90 ? "bad" : p >= 75 ? "warn" : "ok");
export const gb = (b: number) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : `${(b / 1e9).toFixed(1)} GB`);
export const uptime = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)}д ${Math.floor((s % 86400) / 3600)}ч` : `${Math.floor(s / 3600)}ч ${Math.floor((s % 3600) / 60)}м`);
/** The worst of CPU, load per core, memory and disk: the colour of the whole card. */
export function worst(s: Stats): "ok" | "warn" | "bad" {
  const ps = [s.cpu ?? 0, s.load && s.cores ? (100 * s.load[0]) / s.cores : 0, pct(s.mem_used, s.mem_total), pct(s.disk_used, s.disk_total)];
  return level(Math.max(...ps));
}

/** OpsDeck profiles and ~/.ssh/config hosts (wildcards are not hosts). */
export function targets(list: { hosts: SshHost[]; config: ConfigHost[] }): Target[] {
  return [
    ...list.hosts.map((h) => ({ key: `id:${h.id}`, name: h.name, group: h.group, addr: `${h.user ? h.user + "@" : ""}${h.host}` })),
    ...list.config.filter((c) => !/[*?!]/.test(c.alias)).map((c) => ({ key: `alias:${c.alias}`, name: c.alias, group: c.group, addr: `${c.user ? c.user + "@" : ""}${c.hostname || c.alias}` })),
  ];
}

export function mountMonitor(root: HTMLElement) {
  root.innerHTML = `
    <div class="page mon">
      <div class="page-head">
        <h2>Мониторинг ${helpBtn("monitor")}</h2>
        <div class="row">
          <label class="inline">Обновлять <select class="mon-every">
            <option value="15">каждые 15 с</option><option value="30">каждые 30 с</option><option value="60">каждую минуту</option><option value="300">каждые 5 мин</option><option value="0">вручную</option>
          </select></label>
          <button class="ghost" data-a="refresh" title="Обновить сейчас">${icon("refresh", 16)}</button>
          <button class="primary" data-a="pick">${icon("plus", 16)} Хосты</button>
        </div>
      </div>
      <div class="mon-board"></div>
      <dialog class="mon-pick">
        <form method="dialog">
          <h3>Хосты на доске</h3>
          <input class="mon-filter" placeholder="фильтр…" spellcheck="false" />
          <div class="mon-pick-list"></div>
          <p class="muted hint">Профили из раздела SSH и хосты из ~/.ssh/config. Метрики снимаются по ssh: нужен вход по ключу (ssh-agent) или открытая в OpsDeck сессия — пароль доска не спрашивает. Только Linux.</p>
          <div class="actions"><button value="cancel" formnovalidate>Отмена</button><button value="ok" class="primary">Готово</button></div>
        </form>
      </dialog>
    </div>`;

  const board = root.querySelector<HTMLElement>(".mon-board")!;
  const every = root.querySelector<HTMLSelectElement>(".mon-every")!;
  const pick = root.querySelector<HTMLDialogElement>(".mon-pick")!;
  const pickList = pick.querySelector<HTMLElement>(".mon-pick-list")!;
  const pickFilter = pick.querySelector<HTMLInputElement>(".mon-filter")!;
  let all: Target[] = [];
  let chosen: string[] = (() => { try { return JSON.parse(get(KEY_HOSTS) ?? "[]"); } catch { return []; } })();
  const state = new Map<string, State>();
  let timer = 0;

  every.value = get(KEY_EVERY) ?? "30";
  every.onchange = () => { set(KEY_EVERY, every.value); schedule(); };

  async function loadTargets() {
    const list = await invoke<{ hosts: SshHost[]; config: ConfigHost[] }>("ssh_list").catch(() => ({ hosts: [], config: [] }));
    all = targets(list);
  }

  const shown = () => chosen.map((k) => all.find((t) => t.key === k)).filter((t): t is Target => !!t);

  function card(t: Target) {
    const st = state.get(t.key) ?? {};
    const s = st.stats;
    const head = `<div class="mon-head"><span class="mon-dot ${st.error ? "bad" : s ? worst(s) : "idle"}"></span><b>${esc(t.name)}</b><span class="muted mon-addr">${esc(s?.host && s.host !== t.name ? s.host : t.addr)}</span>${st.busy ? `<span class="muted mon-busy">…</span>` : ""}</div>`;
    if (st.error) return `<div class="mon-card bad" data-k="${esc(t.key)}">${head}<p class="mon-err">${esc(st.error)}</p></div>`;
    if (!s) return `<div class="mon-card" data-k="${esc(t.key)}">${head}<p class="muted">опрашиваю…</p></div>`;
    const bar = (label: string, p: number, text: string) =>
      `<div class="mon-row ${level(p)}"><span>${label}</span><i class="mon-bar"><i style="width:${Math.min(100, p).toFixed(0)}%"></i></i><span class="mon-val">${text}</span></div>`;
    const mem = pct(s.mem_used, s.mem_total), disk = pct(s.disk_used, s.disk_total);
    return `<div class="mon-card ${worst(s)}" data-k="${esc(t.key)}">${head}
      ${s.cpu !== null ? bar("CPU", s.cpu, `${s.cpu.toFixed(0)}%`) : `<div class="mon-row"><span>CPU</span><span class="muted">…</span></div>`}
      ${s.load ? `<div class="mon-row ${level(s.cores ? (100 * s.load[0]) / s.cores : 0)}" title="load average 1/5/15 мин"><span>load</span><span class="mon-val">${s.load.map((x) => x.toFixed(2)).join(" ")} <span class="muted">/${s.cores}</span></span></div>` : ""}
      ${bar("RAM", mem, `${gb(s.mem_used)} / ${gb(s.mem_total)}`)}
      ${s.disk_total ? bar(esc(s.disk_mount || "/"), disk, `${gb(s.disk_used)} / ${gb(s.disk_total)}`) : ""}
      <div class="mon-foot muted"><span>up ${uptime(s.uptime)}</span>${st.at ? `<span>${new Date(st.at).toLocaleTimeString()}</span>` : ""}</div>
    </div>`;
  }

  function draw() {
    const list = shown();
    if (!list.length) {
      board.innerHTML = `<p class="muted mon-empty">${all.length ? "Добавьте хосты на доску — кнопка «＋ Хосты»." : "Хостов пока нет — добавьте их в разделе SSH или в ~/.ssh/config."}</p>`;
      return;
    }
    const groups = new Map<string, Target[]>();
    for (const t of list) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);
    board.innerHTML = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([g, ts]) =>
      `<section class="mon-group">${g ? `<div class="side-head small">${esc(g)}</div>` : ""}<div class="mon-grid">${ts.map(card).join("")}</div></section>`).join("");
  }

  async function probe(t: Target) {
    const st = state.get(t.key) ?? {};
    if (st.busy) return;
    state.set(t.key, { ...st, busy: true });
    try {
      const stats = await invoke<Stats>("mon_probe", { target: t.key });
      state.set(t.key, { stats, at: Date.now() });
    } catch (e) {
      state.set(t.key, { error: String(e), at: Date.now() });
    }
    if (!root.hidden) draw();
  }

  /** All hosts, a few at a time. */
  async function refresh() {
    if (root.hidden || document.hidden) return;
    const queue = shown();
    draw();
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) await probe(t);
    }));
  }

  function schedule() {
    clearInterval(timer);
    const sec = Number(every.value);
    if (sec > 0) timer = window.setInterval(refresh, sec * 1000);
  }

  function drawPick() {
    const q = pickFilter.value.trim().toLowerCase();
    const list = all.filter((t) => !q || [t.name, t.addr, t.group].join(" ").toLowerCase().includes(q));
    pickList.innerHTML = list.length ? list.map((t) => `
      <label class="check"><input type="checkbox" data-k="${esc(t.key)}" ${chosen.includes(t.key) ? "checked" : ""} />
        <b>${esc(t.name)}</b> <span class="muted">${esc(t.addr)}${t.group ? ` · ${esc(t.group)}` : ""}${t.key.startsWith("alias:") ? " · ~/.ssh/config" : ""}</span></label>`).join("")
      : `<p class="muted">Ничего не найдено.</p>`;
  }
  pickFilter.oninput = drawPick;
  pickList.addEventListener("change", (e) => {
    const k = (e.target as HTMLInputElement).dataset.k;
    if (!k) return;
    chosen = (e.target as HTMLInputElement).checked ? [...chosen.filter((x) => x !== k), k] : chosen.filter((x) => x !== k);
  });
  let before: string[] = [];
  root.querySelector<HTMLElement>("[data-a=pick]")!.onclick = async () => {
    await loadTargets();
    before = [...chosen];
    pickFilter.value = "";
    drawPick();
    pick.showModal();
  };
  pick.addEventListener("close", () => {
    if (pick.returnValue !== "ok") { chosen = before; return; }
    set(KEY_HOSTS, JSON.stringify(chosen));
    refresh();
  });
  root.querySelector<HTMLElement>("[data-a=refresh]")!.onclick = () => refresh();

  window.addEventListener("view-shown", async (e) => {
    if ((e as CustomEvent).detail !== "monitor") return;
    await loadTargets();
    refresh();
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !root.hidden) refresh(); });
  schedule();
}
