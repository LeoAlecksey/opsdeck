/**
 * Настройки ИИ-агента: что ему можно на каждом хосте и чем ограничены его шаги.
 * Сами расследования запускаются в AI-панели терминала, здесь — только правила и журнал.
 */
import { invoke } from "@tauri-apps/api/core";
import { icon } from "./icons";
import { helpBtn } from "./help";
import { targets, type Target } from "./monitor";
import { esc, toast } from "./ui";
import { natCmp } from "./natsort";

type Mode = "off" | "read" | "ask" | "trusted";
type Policy = {
  enabled: boolean; mode: Mode; hosts: Record<string, Mode>; allow_sudo: boolean; allow_local: boolean;
  max_steps: number; step_timeout_s: number; output_limit: number; extra_read: string[]; deny: string[];
};
type Verdict = { kind: "read" | "write" } | { kind: "forbidden"; reason: string };
type Check = { verdict: Verdict; mode: Mode; allowed_now: boolean; needs_approval: boolean; why: string };
type Audit = { at: string; target: string; command: string; verdict: string; approved: boolean; exit_code: number; took_ms: number };

const MODES: [Mode, string][] = [
  ["off", "Не ходить"],
  ["read", "Только чтение"],
  ["ask", "Менять с разрешения"],
  ["trusted", "Менять без вопросов"],
];

/** Короткое объяснение уровня — то, что увидит человек рядом с выбором. */
export function modeHint(mode: Mode): string {
  return {
    off: "агент сюда не ходит",
    read: "смотрит логи и состояние; изменить ничего не может",
    ask: "смотрит сам, каждое изменение показывает и ждёт кнопку",
    trusted: "меняет без вопросов — только для хостов, которые не жалко",
  }[mode];
}

/** Строка про команду в проверке политики. */
export function checkNote(c: Check): { text: string; kind: "ok" | "warn" | "err" } {
  if (c.verdict.kind === "forbidden") return { text: `не выполнится: ${c.verdict.reason}`, kind: "err" };
  if (c.allowed_now) return { text: c.verdict.kind === "read" ? "чтение — выполнит сам" : "изменение — выполнит сам (хост доверенный)", kind: "ok" };
  if (c.needs_approval) return { text: "изменение — спросит разрешения", kind: "warn" };
  return { text: `не выполнится: ${c.why}`, kind: "err" };
}

const list = (xs: string[]) => xs.join(" ");
const parseList = (s: string) => [...new Set(s.split(/[\s,]+/).filter(Boolean))];

export function mountAiAgent(root: HTMLElement) {
  root.innerHTML = `
    <div class="page agent">
      <div class="page-head">
        <h2>ИИ-агент ${helpBtn("agent")}</h2>
        <div class="row">
          <label class="check big"><input type="checkbox" data-a="enabled" /><span>Разрешить агенту работать</span></label>
        </div>
      </div>
      <p class="muted agent-lead">Агент сам ходит на хост и смотрит, что там происходит: логи, состояние служб, место на дисках. Изменить он может только то, что разрешено здесь, и только тем способом, который виден в диалоге перед выполнением. Вывод с хостов агент считает данными, а не указаниями: что выполнить, решают эти правила, а не текст в логе.</p>
      <div class="agent-body">
        <section class="agent-card">
          <h3>Уровень доступа</h3>
          <label class="row">По умолчанию <select data-a="mode"></select></label>
          <p class="muted mode-hint"></p>
          <label class="check"><input type="checkbox" data-a="allow_local" /><span>Разрешить работать на этой машине</span></label>
          <label class="check"><input type="checkbox" data-a="allow_sudo" /><span>Разрешить sudo <span class="muted">(любая команда под ним считается изменением)</span></span></label>
        </section>
        <section class="agent-card">
          <h3>Рамки одного расследования</h3>
          <label class="row">Шагов не больше <input type="number" data-a="max_steps" min="1" max="100" /></label>
          <label class="row">Ждать команду, с <input type="number" data-a="step_timeout_s" min="1" max="120" /></label>
          <label class="row">Вывода в модель, символов <input type="number" data-a="output_limit" min="500" max="100000" step="500" /></label>
        </section>
        <section class="agent-card">
          <h3>Свои списки</h3>
          <label>Считать чтением <input data-a="extra_read" spellcheck="false" placeholder="например: pgbench rabbitmqctl" /></label>
          <label>Запретить совсем <input data-a="deny" spellcheck="false" placeholder="например: journalctl docker" /></label>
          <p class="muted">Через пробел, по имени команды. Запрет сильнее всего остального.</p>
        </section>
        <section class="agent-card agent-hosts">
          <h3>Хосты</h3>
          <p class="muted">Уровень для отдельного хоста важнее общего.</p>
          <div class="agent-host-list"></div>
        </section>
        <section class="agent-card agent-try">
          <h3>Проверить команду</h3>
          <p class="muted">Что будет, если агент предложит эту команду, — без её выполнения.</p>
          <div class="row">
            <select class="agent-try-host"></select>
            <input class="agent-try-cmd" spellcheck="false" placeholder="systemctl restart nginx" />
            <button data-a="try">Проверить</button>
          </div>
          <p class="agent-try-out"></p>
        </section>
        <section class="agent-card agent-log">
          <h3>Журнал <button class="icon" data-a="reload-log" title="Обновить">${icon("refresh", 16)}</button></h3>
          <div class="agent-log-body"><p class="muted">Пока пусто.</p></div>
        </section>
      </div>
    </div>`;

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const modeSel = $<HTMLSelectElement>("[data-a=mode]");
  const tryHost = $<HTMLSelectElement>(".agent-try-host");
  let policy: Policy | null = null;
  let hosts: Target[] = [];

  for (const [id, title] of MODES) modeSel.add(new Option(title, id));

  const num = (name: string) => $<HTMLInputElement>(`[data-a=${name}]`);
  const check = (name: string) => $<HTMLInputElement>(`[data-a=${name}]`);

  function draw() {
    if (!policy) return;
    check("enabled").checked = policy.enabled;
    // выключенный агент виден сразу: остальные правила гаснут
    $(".agent").classList.toggle("off", !policy.enabled);
    modeSel.value = policy.mode;
    $(".mode-hint").textContent = modeHint(policy.mode);
    check("allow_local").checked = policy.allow_local;
    check("allow_sudo").checked = policy.allow_sudo;
    num("max_steps").value = String(policy.max_steps);
    num("step_timeout_s").value = String(policy.step_timeout_s);
    num("output_limit").value = String(policy.output_limit);
    num("extra_read").value = list(policy.extra_read);
    num("deny").value = list(policy.deny);
    $(".agent-host-list").innerHTML = hosts.length
      ? hosts.map((h) => `<div class="agent-host"><span class="ah-name">${esc(h.name)}</span><span class="muted ah-addr">${esc(h.group ? h.group + " · " : "")}${esc(h.addr)}</span>
          <select data-host="${esc(h.key)}">${MODES.map(([id, t]) => `<option value="${id}"${policy!.hosts[h.key] === id ? " selected" : ""}>${esc(t)}</option>`).join("")}
            <option value=""${policy!.hosts[h.key] ? "" : " selected"}>как по умолчанию</option></select></div>`).join("")
      : `<p class="muted">Хостов нет — добавьте их в разделе SSH или в ~/.ssh/config.</p>`;
  }

  async function save() {
    if (!policy) return;
    await invoke("agent_policy_save", { policy }).catch((e) => toast(String(e), "err"));
  }

  root.addEventListener("change", async (e) => {
    if (!policy) return;
    const el = e.target as HTMLInputElement & HTMLSelectElement;
    const name = el.dataset.a;
    const host = el.dataset.host;
    if (host) {
      if (el.value) policy.hosts[host] = el.value as Mode;
      else delete policy.hosts[host];
    } else if (name === "enabled" || name === "allow_sudo" || name === "allow_local") {
      policy[name] = el.checked;
    } else if (name === "mode") {
      policy.mode = el.value as Mode;
    } else if (name === "max_steps" || name === "step_timeout_s" || name === "output_limit") {
      policy[name] = Number(el.value) || policy[name];
    } else if (name === "extra_read" || name === "deny") {
      policy[name] = parseList(el.value);
    } else return;
    draw();
    await save();
  });

  $("[data-a=try]").onclick = async () => {
    const command = $<HTMLInputElement>(".agent-try-cmd").value.trim();
    const out = $(".agent-try-out");
    if (!command) { out.textContent = ""; return; }
    const c = await invoke<Check>("agent_check", { target: tryHost.value, command }).catch((e) => { toast(String(e), "err"); return null; });
    if (!c) return;
    const note = checkNote(c);
    out.textContent = note.text;
    out.className = `agent-try-out ${note.kind}`;
  };

  async function loadLog() {
    const rows = await invoke<Audit[]>("agent_audit", { limit: 100 }).catch(() => []);
    $(".agent-log-body").innerHTML = rows.length
      ? `<div class="table-wrap"><table class="res"><thead><tr><th>Когда</th><th>Хост</th><th>Команда</th><th>Что это</th><th>Код</th></tr></thead><tbody>${
        rows.map((r) => `<tr><td>${esc(r.at)}</td><td>${esc(r.target)}</td><td><code>${esc(r.command)}</code></td><td>${esc(r.verdict)}${r.approved ? " · с разрешения" : ""}</td><td class="${r.exit_code ? "err" : ""}">${r.exit_code}</td></tr>`).join("")
      }</tbody></table></div>`
      : `<p class="muted">Пока пусто.</p>`;
  }
  $("[data-a=reload-log]").onclick = loadLog;

  (async () => {
    [policy, hosts] = await Promise.all([
      invoke<Policy>("agent_policy"),
      invoke<Parameters<typeof targets>[0]>("ssh_list")
        .then((l) => targets(l).sort((a, b) => natCmp(a.name, b.name)))
        .catch(() => [] as Target[]),
    ]);
    tryHost.innerHTML = [`<option value="local">эта машина</option>`, ...hosts.map((h) => `<option value="${esc(h.key)}">${esc(h.name)}</option>`)].join("");
    draw();
    await loadLog();
  })();
}
