import { locale } from "../i18n";
import { helpBtn } from "./help";
import { icon } from "./icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { age } from "./k8s-details";
import { registerProvider } from "./palette";
import { ask, esc, toast } from "./ui";

type Alert = {
  kind: string; links: { title: string; url: string }[];
  fingerprint: string; status: string; silenced: boolean; source: string; name: string; severity: string;
  summary: string; description: string; labels: Record<string, string>; annotations: Record<string, string>;
  starts_at: string; ends_at: string; generator_url: string; silence_url: string; dashboard_url: string;
  panel_url: string; value: string; received_at: string; acked: boolean;
};
type Mute = { source: string; name: string };
type View = { current: Alert[]; history: Alert[]; firing: number };
type Config = {
  ingest_enabled: boolean; ingest_port: number; poll_enabled: boolean; poll_seconds: number;
  notify: boolean; notify_resolved: boolean; muted: Mute[];
};

const SEV = [
  { id: "crit", label: "critical", re: /crit|high|error|p1|disaster/i },
  { id: "warn", label: "warning", re: /warn|medium|p2|average/i },
  { id: "info", label: "info", re: /info|low|p3|p4|notice/i },
];
const sevClass = (s: string) => SEV.find((x) => x.re.test(s))?.id ?? "other";
const sevRank = (s: string) => ["crit", "warn", "info", "other"].indexOf(sevClass(s));
// labels that are noise in the card (shown elsewhere or internal)
const HIDDEN_LABELS = new Set(["alertname", "severity", "__alert_rule_uid__", "grafana_folder", "__alert_rule_namespace_uid__"]);
const DAY = 86400000;
const ageMs = (a: Alert) => Date.now() - Date.parse(a.starts_at || a.received_at);

/** Same alert rule from the same source: one card with a counter. */
type Group = { key: string; source: string; name: string; items: Alert[]; newest: number; oldest: number };

const prefs = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(`opsdeck.alerts.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(`opsdeck.alerts.${k}`, JSON.stringify(v)); } catch { /* ignore */ } },
};

export function mountAlerts(root: HTMLElement) {
  root.innerHTML = `
    <div class="page alerts">
      <div class="page-head">
        <h2>Алерты <span class="muted small-note al-summary"></span></h2>
        <div class="row">
          <input class="al-filter" placeholder="поиск: имя, метка, текст…" spellcheck="false" />
          <button class="ghost" data-a="poll" title="Опросить источники сейчас">${icon("refresh", 16)} Опросить</button>
          <button class="ghost" data-a="settings" title="Настройки опроса, уведомлений и скрытые алерты">${icon("settings", 16)}</button>
          ${helpBtn("alerts")}
        </div>
      </div>
      <div class="al-errors err" hidden></div>
      <form class="al-settings" hidden>
        <p class="muted">Источники заводятся в «Веб-панелях» (◎): Grafana (логин/пароль, токен service account или KeePass), Prometheus Alertmanager и «AI / анализатор». OpsDeck сам их опрашивает — извне на этот компьютер ничего не приходит, IP и NAT не важны.</p>
        <div class="row wrap">
          <label class="check"><input type="checkbox" name="poll_enabled" /> Опрашивать</label>
          <label>каждые <input type="number" name="poll_seconds" min="15" max="3600" /> с</label>
          <label class="check"><input type="checkbox" name="notify" /> Уведомления на рабочем столе</label>
          <label class="check"><input type="checkbox" name="notify_resolved" /> …и о восстановлении</label>
          <label class="check"><input type="checkbox" name="ingest_enabled" /> Приём от локальных анализаторов на 127.0.0.1:</label>
          <input type="number" name="ingest_port" min="1024" max="65535" />
          <button class="primary">Сохранить</button>
        </div>
        <div class="al-muted-list"></div>
      </form>
      <div class="al-toolbar">
        <div class="seg al-sev-filter">
          <button type="button" data-sev="crit">critical <b></b></button>
          <button type="button" data-sev="warn">warning <b></b></button>
          <button type="button" data-sev="info">info <b></b></button>
          <button type="button" data-sev="other">прочие <b></b></button>
        </div>
        <select class="al-source" title="Источник"></select>
        <select class="al-group" title="Как группировать">
          <option value="name">группировать одинаковые</option>
          <option value="none">каждый алерт отдельно</option>
        </select>
      </div>
      <div class="al-current"></div>
      <details class="al-history-wrap">
        <summary class="side-head small">История <button class="ghost al-clear" type="button" data-a="clear-history">очистить</button></summary>
        <table class="res al-history"><thead><tr><th>Когда</th><th>Статус</th><th>Алерт</th><th>Severity</th><th>Описание</th><th>Источник</th></tr></thead><tbody></tbody></table>
      </details>
    </div>`;

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const current = $(".al-current"), hist = $(".al-history tbody"), filter = $<HTMLInputElement>(".al-filter");
  const form = $<HTMLFormElement>(".al-settings"), errors = $(".al-errors");
  const sourceSel = $<HTMLSelectElement>(".al-source"), groupSel = $<HTMLSelectElement>(".al-group");
  const f = (n: keyof Config) => form.elements.namedItem(n) as HTMLInputElement;
  let data: View = { current: [], history: [], firing: 0 };
  let muted: Mute[] = [];
  let sources: string[] = [];
  // severities shown (all by default); sections that are collapsed
  let sevOn = new Set<string>(prefs.get("sev", ["crit", "warn", "info", "other"]));
  const closed = new Set<string>(prefs.get("closed", ["old", "quiet"]));
  groupSel.value = prefs.get("group", "name");

  const isMuted = (a: Alert) => muted.some((m) => m.name === a.name && (!m.source || m.source === a.source));
  const match = (a: Alert) => {
    const q = filter.value.trim().toLowerCase();
    return (!sourceSel.value || a.source === sourceSel.value) && sevOn.has(sevClass(a.severity)) &&
      (!q || [a.name, a.summary, a.description, a.source, a.severity, ...Object.entries(a.labels).map(([k, v]) => `${k}=${v}`)]
        .join(" ").toLowerCase().includes(q));
  };

  /** Group key, safe inside an HTML attribute (a raw "\u0000" separator was turned into "\uFFFD" by
   *  the parser, so the buttons of a card never found their alerts). */
  const groupKey = (a: Alert) => encodeURIComponent(groupSel.value === "none" ? a.fingerprint : `${a.source}\n${a.name}`);
  function groups(list: Alert[]): Group[] {
    const by = new Map<string, Group>();
    for (const a of list) {
      const key = groupKey(a);
      const g = by.get(key) ?? { key, source: a.source, name: a.name, items: [], newest: 0, oldest: 0 };
      g.items.push(a);
      by.set(key, g);
    }
    for (const g of by.values()) {
      const ages = g.items.map(ageMs);
      g.newest = Math.min(...ages);
      g.oldest = Math.max(...ages);
      g.items.sort((x, y) => ageMs(x) - ageMs(y));
    }
    return [...by.values()].sort((x, y) => sevRank(x.items[0].severity) - sevRank(y.items[0].severity) || x.newest - y.newest);
  }

  /** Labels whose values differ between instances of a group — what tells them apart. */
  function distinguishing(items: Alert[]): string[] {
    if (items.length < 2) return [];
    const keys = new Set(items.flatMap((a) => Object.keys(a.labels)).filter((k) => !HIDDEN_LABELS.has(k)));
    return [...keys].filter((k) => new Set(items.map((a) => a.labels[k] ?? "")).size > 1).slice(0, 4);
  }

  function linksOf(a: Alert): [string, string][] {
    return [
      a.panel_url && ["Панель", a.panel_url], a.dashboard_url && ["Дашборд", a.dashboard_url],
      a.generator_url && ["Правило", a.generator_url], a.silence_url && ["Silence", a.silence_url],
      ...(a.links ?? []).map((l) => [l.title || "Ссылка", l.url]),
    ].filter(Boolean) as [string, string][];
  }

  function card(g: Group) {
    const a = g.items[0];
    const n = g.items.length;
    const ai = a.kind === "ai";
    const labels = n === 1 ? Object.entries(a.labels).filter(([k]) => !HIDDEN_LABELS.has(k)) : [];
    const diff = distinguishing(g.items);
    const acked = g.items.every((x) => x.acked);
    const longDesc = a.description.length > 400;
    const since = n > 1 && g.oldest - g.newest > 3600000
      ? `${age(new Date(Date.now() - g.newest).toISOString())} … ${age(new Date(Date.now() - g.oldest).toISOString())}`
      : age(a.starts_at);
    return `<div class="al-card sev-${sevClass(a.severity)} ${acked ? "acked" : ""} ${a.silenced ? "silenced" : ""}" data-g="${esc(g.key)}">
      <div class="al-head">
        <span class="al-sev">${esc(a.severity || "—")}</span>
        ${ai ? `<span class="badge ai" title="Находка AI-анализатора">🤖 AI</span>` : ""}
        <strong class="al-name">${esc(a.name)}</strong>
        ${n > 1 ? `<span class="al-count" title="Сколько экземпляров горит">×${n}</span>` : ""}
        ${a.silenced ? `<span class="badge">silenced</span>` : ""}${acked ? `<span class="badge">просмотрен</span>` : ""}
        <span class="spacer"></span>
        <span class="muted" title="Горит с ${esc(new Date(a.starts_at).toLocaleString(locale()))}">${esc(since)} · ${esc(a.source)}</span>
      </div>
      ${a.summary ? `<div class="al-summary-text">${esc(a.summary)}</div>` : ""}
      ${a.description && a.description !== a.summary ? (longDesc
        ? `<details class="al-desc"><summary class="muted">${esc(a.description.slice(0, 200))}…</summary><div class="muted">${esc(a.description)}</div></details>`
        : `<div class="muted al-desc">${esc(a.description)}</div>`) : ""}
      ${n === 1 && a.value ? `<div class="mono muted al-value">${esc(a.value)}</div>` : ""}
      ${labels.length ? `<div class="chips">${labels.map(([k, v]) => `<span class="chip">${esc(k)}=${esc(v)}</span>`).join("")}</div>` : ""}
      ${n > 1 ? `<details class="al-instances" ${n <= 3 ? "open" : ""}><summary class="muted">экземпляры (${n})</summary>
        <table class="res"><tbody>${g.items.map((x) => `<tr>
          <td>${diff.length ? diff.map((k) => `<span class="chip">${esc(k)}=${esc(x.labels[k] ?? "—")}</span>`).join(" ") : esc(x.summary || x.fingerprint.slice(0, 8))}</td>
          <td class="muted">${esc(age(x.starts_at))}</td>
          <td class="al-inst-links">${linksOf(x).slice(0, 2).map(([t, u]) => `<button class="ghost" data-url="${esc(u)}">${esc(t)} ↗</button>`).join("")}</td></tr>`).join("")}
        </tbody></table></details>` : ""}
      <div class="al-actions">
        ${n === 1 ? linksOf(a).map(([t, u]) => `<button class="ghost" data-url="${esc(u)}">${esc(t)} ↗</button>`).join("") : ""}
        <span class="spacer"></span>
        <button class="ghost" data-a="ai">⇢ AI</button>
        <button class="ghost" data-a="ack">${acked ? "Вернуть" : "✓ Просмотрен"}</button>
        ${ai ? `<button class="ghost" data-a="resolve" title="Убрать в историю">Закрыть</button>` : ""}
        <button class="ghost" data-a="mute" title="Больше не показывать алерты «${esc(a.name)}» из ${esc(a.source)} (вернуть — в ⚙)">${icon("bellOff", 16)} Скрыть такие</button>
      </div>
    </div>`;
  }

  function section(id: string, title: string, gs: Group[], hint = "") {
    if (!gs.length) return "";
    const count = gs.reduce((s, g) => s + g.items.length, 0);
    return `<details class="al-section" data-sec="${id}" ${closed.has(id) ? "" : "open"}>
      <summary><span class="al-sec-title">${title}</span> <span class="al-sec-count">${count}</span>${hint ? ` <span class="muted">${hint}</span>` : ""}</summary>
      <div class="al-sec-body">${gs.map(card).join("")}</div></details>`;
  }

  function draw() {
    const visible = data.current.filter((a) => !isMuted(a));
    // toolbar counters reflect the other filters
    for (const s of ["crit", "warn", "info", "other"]) {
      const b = root.querySelector<HTMLElement>(`[data-sev=${s}]`)!;
      b.classList.toggle("active", sevOn.has(s));
      b.querySelector("b")!.textContent = String(visible.filter((a) => sevClass(a.severity) === s && !a.acked && !a.silenced).length);
    }
    const srcs = [...new Set(data.current.map((a) => a.source))].sort();
    const cur = sourceSel.value;
    sourceSel.innerHTML = `<option value="">все источники</option>` + srcs.map((s) => `<option>${esc(s)}</option>`).join("");
    sourceSel.value = srcs.includes(cur) ? cur : "";

    const shown = visible.filter(match);
    const quiet = shown.filter((a) => a.acked || a.silenced);
    const active = shown.filter((a) => !a.acked && !a.silenced);
    const fresh = active.filter((a) => ageMs(a) < DAY);
    const week = active.filter((a) => ageMs(a) >= DAY && ageMs(a) < 7 * DAY);
    const old = active.filter((a) => ageMs(a) >= 7 * DAY);
    const mutedNow = data.current.filter(isMuted).length;

    current.innerHTML = !sources.length ? onboarding()
      : !data.current.length ? `<div class="al-empty">✓ Горящих алертов нет · источники: ${esc(sources.join(", "))}</div>`
      : (section("new", "🆕 Новые", groups(fresh), "за последние 24 часа") +
         section("week", "За неделю", groups(week)) +
         section("old", "Давно горят", groups(old), "больше 7 дней — скорее всего, фон или забытые правила") +
         section("quiet", "Просмотренные и заглушённые", groups(quiet))) ||
        `<div class="al-empty">Ничего не подходит под фильтры</div>`;
    $(".al-summary").textContent = `горит ${data.firing}${mutedNow ? ` · скрыто правилами ${mutedNow}` : ""}`;

    hist.innerHTML = data.history.filter(match).slice(0, 300).map((a) => `<tr>
      <td title="${esc(new Date(a.received_at).toLocaleString(locale()))}">${esc(age(a.received_at))}</td>
      <td class="${a.status === "resolved" ? "ok" : "bad"}">${a.status === "resolved" ? "resolved" : "firing"}</td>
      <td>${esc(a.name)}</td><td>${esc(a.severity)}</td><td class="wrap">${esc(a.summary || a.description)}</td><td class="muted">${esc(a.source)}</td></tr>`).join("")
      || `<tr><td class="muted" colspan="6">Пока пусто</td></tr>`;
  }

  /** No sources yet: how to connect, with buttons that open the right connector dialog. */
  function onboarding() {
    return `<div class="al-onboard">
      <h3>Откуда брать алерты</h3>
      <p class="muted">OpsDeck сам опрашивает источники — в Grafana/Alertmanager ничего настраивать не нужно, на этот компьютер ничего не присылается.</p>
      <ol>
        <li><b>Grafana</b>: в Grafana создайте токен — Administration → Users and access → Service accounts → Add service account (роль Viewer) → Add service account token. Затем здесь «＋ Grafana», авторизация «токен», «Сохранить и проверить».</li>
        <li><b>Prometheus Alertmanager</b>: «＋ Alertmanager», URL вида http://alertmanager:9093.</li>
        <li><b>Свой AI-анализатор</b>: «＋ AI-анализатор» — в карточке будет адрес, токен и пример curl.</li>
      </ol>
      <div class="row">
        <button class="primary" data-add="grafana">${icon("plus", 16)} Grafana</button>
        <button data-add="alertmanager">${icon("plus", 16)} Alertmanager</button>
        <button data-add="ai">${icon("plus", 16)} AI-анализатор</button>
      </div>
    </div>`;
  }

  async function load() {
    sources = await invoke<string[]>("alerts_sources").catch(() => sources);
    data = await invoke<View>("alerts_get", { historyLimit: 300 }).catch(() => data);
    muted = (await invoke<Config>("alerts_config_get").catch(() => null))?.muted ?? muted;
    draw();
    drawMuted();
  }

  function drawMuted() {
    const box = $(".al-muted-list");
    box.innerHTML = muted.length ? `<div class="side-head small">Скрытые алерты</div>
      <table class="res"><tbody>${muted.map((m, i) => `<tr><td>${esc(m.name)}</td><td class="muted">${esc(m.source || "любой источник")}</td>
        <td class="sn-acts"><button type="button" class="ghost" data-unmute="${i}">вернуть</button></td></tr>`).join("")}</tbody></table>`
      : `<p class="muted">Скрытых алертов нет. «🔕 Скрыть такие» на карточке убирает алерты с этим именем из списка, счётчика и уведомлений.</p>`;
  }

  async function loadConfig() {
    const c = await invoke<Config>("alerts_config_get");
    f("poll_enabled").checked = c.poll_enabled;
    f("poll_seconds").value = String(c.poll_seconds);
    f("notify").checked = c.notify;
    f("notify_resolved").checked = c.notify_resolved;
    f("ingest_enabled").checked = c.ingest_enabled;
    f("ingest_port").value = String(c.ingest_port);
    muted = c.muted ?? [];
    drawMuted();
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const config: Config = {
      poll_enabled: f("poll_enabled").checked, poll_seconds: Math.max(15, Number(f("poll_seconds").value) || 60),
      notify: f("notify").checked, notify_resolved: f("notify_resolved").checked,
      ingest_enabled: f("ingest_enabled").checked, ingest_port: Number(f("ingest_port").value) || 9095,
      muted,
    };
    await invoke("alerts_config_set", { config }).then(() => toast("Сохранено"), (err) => toast(String(err), "err"));
  };

  const groupOf = (el: HTMLElement): Alert[] => {
    const key = el.closest<HTMLElement>("[data-g]")?.dataset.g;
    if (!key) return [];
    return data.current.filter((a) => groupKey(a) === key);
  };

  root.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const add = t.closest<HTMLElement>("[data-add]")?.dataset.add;
    if (add) return window.dispatchEvent(new CustomEvent("add-connector", { detail: add }));
    const url = t.closest<HTMLElement>("[data-url]")?.dataset.url;
    if (url) return window.dispatchEvent(new CustomEvent("open-url", { detail: url }));
    const sev = t.closest<HTMLElement>("[data-sev]")?.dataset.sev;
    if (sev) {
      // click = only this severity; click on the only active one = all again
      sevOn = sevOn.size === 1 && sevOn.has(sev) ? new Set(["crit", "warn", "info", "other"]) : new Set([sev]);
      prefs.set("sev", [...sevOn]);
      return draw();
    }
    const un = t.closest<HTMLElement>("[data-unmute]")?.dataset.unmute;
    if (un !== undefined) {
      const m = muted[Number(un)];
      await invoke("alerts_mute", { source: m.source, name: m.name, muted: false });
      return load();
    }
    const act = t.closest<HTMLElement>("[data-a]")?.dataset.a;
    const items = groupOf(t);
    const a = items[0];
    if (act === "settings") { form.hidden = !form.hidden; if (!form.hidden) loadConfig(); }
    if (act === "poll") {
      const errs = await invoke<string[]>("alerts_poll_now");
      showErrors(errs);
      if (!errs.length) toast("Опрошено");
      load();
    }
    if (act === "clear-history" && (await ask("История алертов", "Очистить историю?", { ok: "Очистить", danger: true })) !== null) {
      await invoke("alerts_clear", { current: false, history: true });
      load();
    }
    if (!a) return;
    if (act === "resolve") { for (const x of items) await invoke("alerts_resolve", { fingerprint: x.fingerprint }); load(); }
    if (act === "ack") {
      const to = !items.every((x) => x.acked);
      for (const x of items) await invoke("alerts_ack", { fingerprint: x.fingerprint, acked: to });
      load();
    }
    if (act === "mute") {
      await invoke("alerts_mute", { source: a.source, name: a.name, muted: true });
      toast(`«${a.name}» скрыт. Вернуть: ⚙ → Скрытые алерты`);
      load();
    }
    if (act === "ai") {
      const inst = items.length > 1 ? `\nЭкземпляров: ${items.length}; метки: ${items.slice(0, 10).map((x) => Object.entries(x.labels).filter(([k]) => !HIDDEN_LABELS.has(k)).map(([k, v]) => `${k}=${v}`).join(" ")).join(" | ")}` : "";
      window.dispatchEvent(new CustomEvent("send-to-ai", { detail:
        `${a.kind === "ai" ? "Находка AI-анализатора" : "Алерт"} (${a.source}): ${a.name}, severity ${a.severity || "—"}, горит с ${new Date(a.starts_at).toLocaleString(locale())}.\n` +
        `${a.summary}\n${a.description}\n${a.value ? `Значения: ${a.value}\n` : ""}Метки: ${Object.entries(a.labels).map(([k, v]) => `${k}=${v}`).join(", ")}${inst}\n` +
        `Что это может значить и что проверить в первую очередь?` }));
    }
  });

  // remember which sections are collapsed
  root.addEventListener("toggle", (e) => {
    const d = e.target as HTMLElement;
    const id = d.dataset?.sec;
    if (!id) return;
    (d as HTMLDetailsElement).open ? closed.delete(id) : closed.add(id);
    prefs.set("closed", [...closed]);
  }, true);

  function showErrors(errs: string[]) {
    errors.hidden = !errs.length;
    errors.textContent = errs.length ? `Не удалось опросить: ${errs.join("; ")}` : "";
  }

  filter.oninput = draw;
  sourceSel.onchange = draw;
  groupSel.onchange = () => { prefs.set("group", groupSel.value); draw(); };
  listen("alerts-changed", load);
  listen<string[]>("alerts-poll", (e) => showErrors(e.payload));
  window.addEventListener("view-shown", (e) => { if ((e as CustomEvent).detail === "alerts") load(); });
  registerProvider(() => data.current.filter((a) => !isMuted(a)).map((a) => ({
    group: "Алерт", title: a.name, hint: `${a.severity} · ${a.source}`,
    run: () => { window.dispatchEvent(new CustomEvent("show-view", { detail: "alerts" })); filter.value = a.name; draw(); },
  })));
  // settings open by default until there is anything to show
  invoke<Config>("alerts_config_get").then((c) => { if (!c.poll_enabled) { form.hidden = false; loadConfig(); } });
  load();
}
