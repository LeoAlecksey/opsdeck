import { helpBtn } from "./help";
import { icon } from "./icons";
import { invoke } from "@tauri-apps/api/core";
import { esc } from "./ui";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

const TOOLS: Record<string, { label: string; fields: ("count" | "server" | "record" | "port")[] }> = {
  ping: { label: "ping", fields: ["count"] },
  mtr: { label: "mtr (report)", fields: ["count"] },
  traceroute: { label: "traceroute", fields: [] },
  dig: { label: "dig", fields: ["record", "server"] },
  nslookup: { label: "nslookup", fields: ["record", "server"] },
  port: { label: "TCP-порт", fields: ["port"] },
};
const RECORDS = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "SRV", "PTR", "CAA", "ANY"];

let seq = 0;

export function mountNetwork(root: HTMLElement) {
  root.innerHTML = `
    <div class="page net">
      <div class="page-head">
        <h2>Сеть и DNS ${helpBtn("net")}</h2>
        <div class="seg net-tabs"><button type="button" data-tab="tools" class="active">Утилиты</button><button type="button" data-tab="ports">Порты</button></div>
      </div>
      <div class="net-pane" data-pane="ports" hidden>
        <form class="toolbar ports-form">
          <input name="ptarget" placeholder="хост или IP, например 10.0.0.5" required autocomplete="off" spellcheck="false" />
          <input name="pspec" class="pspec" value="21,22,23,25,53,80,110,143,443,445,3306,3389,5432,6379,6443,8080,8443,9090,9100" spellcheck="false" title="Порты: через запятую и диапазоны, например 22,80,8000-8100" />
          <select name="preset" title="Готовые наборы портов">
            <option value="">набор…</option>
            <option value="21,22,23,25,53,80,110,143,443,445,3306,3389,5432,6379,6443,8080,8443,9090,9100">популярные</option>
            <option value="80,443,3000,5000,8000,8080,8081,8443,8888,9000">веб</option>
            <option value="1433,1521,3306,5432,6379,9042,9200,11211,27017">базы данных</option>
            <option value="2379,2380,6443,8472,9100,10250,10256,30000-30100">kubernetes</option>
            <option value="21,22,23,53,80,443,8291,8728,8729">mikrotik</option>
            <option value="1-1024">1–1024</option>
            <option value="1-65535">все (долго)</option>
          </select>
          <label class="muted"><input type="checkbox" name="onlyopen" checked /> только открытые</label>
          <button type="submit" class="primary">Проверить</button>
          <span class="muted pstate"></span>
        </form>
        <table class="res ports-table"><thead><tr><th>Порт</th><th>Статус</th><th>Обычно</th><th>Что отвечает</th><th>мс</th></tr></thead><tbody></tbody></table>
        <div class="page-head listen-head">
          <h3>Эта машина слушает</h3>
          <div class="row"><input class="lfilter" placeholder="фильтр: порт, процесс…" spellcheck="false" /><button type="button" class="ghost" data-act="listen">${icon("refresh", 16)} Обновить</button></div>
        </div>
        <table class="res listen-table"><thead><tr><th>Протокол</th><th>Адрес</th><th>Порт</th><th>Процесс</th><th>PID</th><th>Обычно</th></tr></thead><tbody></tbody></table>
        <p class="muted small">Процессы других пользователей (например, системные sshd, DNS) без прав root не видны — у них пустое имя.</p>
      </div>
      <div class="net-pane" data-pane="tools">
      <form class="toolbar">
        <select name="tool"></select>
        <input name="target" placeholder="хост или IP, например 8.8.8.8" required autocomplete="off" spellcheck="false" />
        <label data-f="count">кол-во <input name="count" type="number" min="1" max="1000" value="4" /></label>
        <label data-f="record">тип <select name="record"></select></label>
        <label data-f="server">DNS <input name="server" placeholder="по умолчанию" spellcheck="false" /></label>
        <label data-f="port">порт <input name="port" type="number" min="1" max="65535" value="443" /></label>
        <button type="submit" class="primary">Запустить</button>
        <button type="button" data-act="stop" disabled>Стоп</button>
        <button type="button" data-act="clear" class="ghost">Очистить</button>
      </form>
      <pre class="output"></pre>
      </div>
    </div>`;

  root.querySelector<HTMLElement>(".net-tabs")!.onclick = (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]")?.dataset.tab;
    if (!tab) return;
    root.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    root.querySelectorAll<HTMLElement>("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== tab));
    root.dispatchEvent(new CustomEvent("net-tab", { detail: tab }));
  };
  mountPorts(root);
  const form = root.querySelector<HTMLFormElement>("[data-pane=tools] form")!;
  const out = root.querySelector<HTMLElement>(".output")!;
  const stopBtn = root.querySelector<HTMLButtonElement>("[data-act=stop]")!;
  const runBtn = root.querySelector<HTMLButtonElement>("[type=submit]")!;
  const toolSel = form.elements.namedItem("tool") as HTMLSelectElement;
  const recordSel = form.elements.namedItem("record") as HTMLSelectElement;

  for (const [id, t] of Object.entries(TOOLS)) toolSel.add(new Option(t.label, id));
  for (const r of RECORDS) recordSel.add(new Option(r, r));

  const syncFields = () => {
    const f = TOOLS[toolSel.value].fields;
    root.querySelectorAll<HTMLElement>("[data-f]").forEach((el) => (el.hidden = !f.includes(el.dataset.f as never)));
  };
  toolSel.onchange = syncFields;
  syncFields();

  let current: { runId: string; unlisten: UnlistenFn[] } | null = null;

  const append = (text: string, cls = "") => {
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = text;
    out.appendChild(line);
    out.scrollTop = out.scrollHeight;
  };

  const finish = () => {
    current?.unlisten.forEach((u) => u());
    current = null;
    stopBtn.disabled = true;
    runBtn.disabled = false;
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (current) return;
    const v = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value.trim();
    const runId = `run${++seq}`;
    // output can arrive before tool_run returns the command line: hold it until "$ cmd" is shown
    let held: (() => void)[] | null = [];
    const show = (f: () => void) => (held ? held.push(f) : f());
    const unlisten = [
      await listen<{ stream: string; text: string }>(`tool-line-${runId}`, (ev) =>
        show(() => append(ev.payload.text, ev.payload.stream === "err" ? "err" : ""))),
      await listen<number | null>(`tool-exit-${runId}`, (ev) => show(() => {
        append(`— завершено, код ${ev.payload ?? "прерван"}`, "muted");
        finish();
      })),
    ];
    const release = () => { const h = held ?? []; held = null; h.forEach((f) => f()); };
    current = { runId, unlisten };
    stopBtn.disabled = false;
    runBtn.disabled = true;
    try {
      const cmd = await invoke<string>("tool_run", {
        runId,
        req: {
          tool: toolSel.value, target: v("target"), count: Number(v("count")) || undefined,
          record: v("record"), server: v("server") || undefined, port: Number(v("port")) || undefined,
        },
      });
      append(`$ ${cmd}`, "cmd");
      release();
    } catch (err) {
      held = null;
      append(String(err), "err");
      finish();
    }
  };

  stopBtn.onclick = () => current && invoke("tool_stop", { runId: current.runId });
  root.querySelector<HTMLElement>("[data-act=clear]")!.onclick = () => (out.textContent = "");
}

/** Port tools: TCP scan of a host and the listening sockets of this machine. */
function mountPorts(root: HTMLElement) {
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const form = q<HTMLFormElement>(".ports-form");
  const f = (n: string) => form.elements.namedItem(n) as HTMLInputElement & HTMLSelectElement;
  const tbody = q(".ports-table tbody"), lbody = q(".listen-table tbody"), state = q(".pstate");
  type R = { port: number; state: string; service: string; banner: string; ms: number };
  let results: R[] = [];
  let unlisten: UnlistenFn | null = null;
  let seqP = 0;

  const draw = () => {
    const only = f("onlyopen").checked;
    const rows = results.filter((r) => !only || r.state === "open").sort((a, b) => a.port - b.port);
    const label: Record<string, string> = { open: "открыт", closed: "закрыт", filtered: "фильтруется" };
    tbody.innerHTML = rows.map((r) => `<tr><td class="mono">${r.port}</td><td class="${r.state === "open" ? "ok" : r.state === "closed" ? "muted" : "warn"}">${label[r.state] ?? r.state}</td>
      <td class="muted">${esc(r.service)}</td><td class="mono wrap">${esc(r.banner)}</td><td class="muted">${r.ms}</td></tr>`).join("")
      || `<tr><td colspan="5" class="muted">${results.length ? "открытых портов нет" : "укажите хост и порты"}</td></tr>`;
  };
  f("preset").onchange = () => { if (f("preset").value) f("pspec").value = f("preset").value; f("preset").value = ""; };
  f("onlyopen").onchange = draw;

  form.onsubmit = async (e) => {
    e.preventDefault();
    unlisten?.();
    results = [];
    draw();
    const id = `ps${++seqP}`;
    let total = 0;
    unlisten = await listen<R & { type: string; ip?: string; open?: number; closed?: number; filtered?: number }>(`port-scan-${id}`, (ev) => {
      const m = ev.payload;
      if (m.type === "result") { results.push(m); state.textContent = `проверено ${results.length} из ${total}…`; draw(); }
      if (m.type === "done") { state.textContent = `${m.ip}: открыто ${m.open}, закрыто ${m.closed}, фильтруется ${m.filtered}`; unlisten?.(); unlisten = null; }
    });
    try {
      total = await invoke<number>("ports_scan", { id, target: f("ptarget").value.trim(), ports: f("pspec").value, timeoutMs: null });
      state.textContent = `проверяю ${total} портов…`;
    } catch (err) { state.textContent = String(err); unlisten?.(); unlisten = null; }
  };

  type L = { proto: string; addr: string; port: number; pid: number | null; process: string; service: string };
  let listeners: L[] = [];
  const drawL = () => {
    const fl = q<HTMLInputElement>(".lfilter").value.trim().toLowerCase();
    lbody.innerHTML = listeners.filter((l) => !fl || `${l.port} ${l.process} ${l.addr} ${l.proto} ${l.service}`.toLowerCase().includes(fl))
      .map((l) => `<tr><td>${l.proto}</td><td class="mono">${esc(l.addr)}</td><td class="mono">${l.port}</td><td>${esc(l.process || "—")}</td>
        <td class="muted">${l.pid ?? ""}</td><td class="muted">${esc(l.service)}</td></tr>`).join("")
      || `<tr><td colspan="6" class="muted">ничего не найдено</td></tr>`;
  };
  const loadL = async () => {
    listeners = await invoke<L[]>("ports_listening").catch((err) => { lbody.innerHTML = `<tr><td colspan="6" class="err">${esc(err)}</td></tr>`; return []; });
    drawL();
  };
  q(".lfilter").oninput = drawL;
  q<HTMLElement>("[data-act=listen]").onclick = loadL;
  root.addEventListener("net-tab", (e) => { if ((e as CustomEvent).detail === "ports" && !listeners.length) loadL(); });
  draw();
}
