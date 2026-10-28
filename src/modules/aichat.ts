/**
 * The local AI as a chat in the terminal's AI panel: the built-in model (or the external server from
 * Settings → Local AI). Answers stream in; commands in ``` blocks get «В терминал» (inserted into the
 * active pane without Enter — nothing runs by itself) and «Копировать».
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ask, esc, toast } from "./ui";
import { t } from "../i18n";
import { uid } from "./winid";
import { investigate, type Event as AgentEvent, type Check, type Run } from "./agentrun";

export type ChatMsg = { role: "user" | "assistant"; content: string };

/** Splits an answer into text and ``` code blocks; drops <think>…</think> of reasoning models. */
export function parts(text: string): { kind: "text" | "code"; lang: string; body: string }[] {
  const clean = text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trimStart();
  const out: { kind: "text" | "code"; lang: string; body: string }[] = [];
  const re = /```([\w+-]*)[^\n]*\n([\s\S]*?)(```|$)/g;
  let last = 0;
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    if (m.index > last) out.push({ kind: "text", lang: "", body: clean.slice(last, m.index) });
    out.push({ kind: "code", lang: m[1], body: m[2].replace(/\n$/, "") });
    last = re.lastIndex;
    if (!m[3]) break; // an unfinished block while streaming
  }
  if (last < clean.length) out.push({ kind: "text", lang: "", body: clean.slice(last) });
  // blank lines around a code block are layout, not text
  return out.filter((p) => p.kind === "code" || p.body.trim()).map((p) => (p.kind === "text" ? { ...p, body: p.body.replace(/^\n+|\n+$/g, "") } : p));
}

/** Text with **bold** and `code`; everything escaped first. */
function inline(s: string): string {
  return esc(s).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
}


/** Что вкладка чата знает о своей привязке (#97): к вкладке терминала или к серверу из списка SSH. */
export type ChatTarget = { tab?: string; server?: { key: string; name: string } };

export type ChatOpts = {
  /** context sent with each question: of the bound terminal tab, else of the active one */
  context: (target?: ChatTarget) => { cwd?: string; shell?: string | null };
  /** puts a command into a terminal pane (no Enter): the bound tab's, else the active one */
  insert: (cmd: string, target?: ChatTarget) => void;
  /** хосты для агента: имя — для модели, ключ — для бэкенда */
  hosts?: () => Promise<{ key: string; name: string }[]>;
  /** открытые вкладки терминала — к ним можно привязать вкладку чата */
  terminalTabs?: () => { id: string; title: string }[];
};

type Policy = { enabled: boolean; max_steps: number };

/** Сообщение разговора. `agent` — вопрос расследования и его итог: модели дальше не передаются. */
type Entry = { role: "user" | "assistant"; content: string; agent?: boolean };
type Bind = { kind: "tab"; id: string; title: string } | { kind: "server"; key: string; name: string } | null;
type ChatTab = { id: string; title: string; named: boolean; bind: Bind; entries: Entry[]; log: HTMLElement; btn: HTMLElement };
type Saved = { tabs: { id: string; title: string; named: boolean; server: { key: string; name: string } | null; entries: Entry[] }[]; current: string };

export const MAX_CHAT_TABS = 8;
const HISTORY_KEY = "opsdeck.ai.chatHistory";

/** Сохранять ли разговоры между запусками (#100); по умолчанию — да. */
export function chatHistoryEnabled(): boolean {
  try { return localStorage.getItem(HISTORY_KEY) !== "0"; } catch { return true; }
}

/** Выключение стирает уже сохранённое: галочка «не сохранять» не должна оставлять файл на диске. */
export async function setChatHistoryEnabled(on: boolean) {
  try { localStorage.setItem(HISTORY_KEY, on ? "1" : "0"); } catch { /* ignore */ }
  if (!on) await invoke("ai_chat_history_clear");
  window.dispatchEvent(new CustomEvent("ai-chat-history", { detail: on }));
}

/** «Удалить сохранённую историю»: файл и все открытые разговоры. */
export async function forgetChatHistory() {
  await invoke("ai_chat_history_clear");
  window.dispatchEvent(new CustomEvent("ai-chat-forget"));
}

/** Название вкладки по первому вопросу: первая строка, коротко. */
export function titleFrom(question: string): string {
  const line = question.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 28 ? `${line.slice(0, 27).trimEnd()}…` : line;
}

/** Только то, что можно передать модели как разговор: без расследований агента. */
export function modelHistory(entries: Entry[]): ChatMsg[] {
  return entries.filter((e) => !e.agent).map((e) => ({ role: e.role, content: e.content }));
}

const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export class LocalChat {
  readonly el: HTMLElement;
  private tabs: ChatTab[] = [];
  private cur!: ChatTab;
  private seq = 0;
  private busy: { id: string; un: UnlistenFn[]; tab: ChatTab } | null = null;
  private logs: HTMLElement;
  private tabsEl: HTMLElement;
  private bindSel: HTMLSelectElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private policy: Policy | null = null;
  /** нажали «Стоп»: цикл расследования смотрит сюда перед каждым шагом */
  private stopped = false;
  /** что-то спросили до того, как пришла сохранённая история: её тогда не накладываем сверху */
  private touched = false;
  private saveTimer = 0;
  private hosts: { key: string; name: string }[] = [];
  private onHistoryPref = (e: Event) => { if ((e as CustomEvent<boolean>).detail) this.saveNow(); else clearTimeout(this.saveTimer); };
  private onForget = () => {
    clearTimeout(this.saveTimer);
    this.stop();
    this.tabs.splice(0).forEach((t) => { t.btn.remove(); t.log.remove(); });
    this.seq = 0;
    this.select(this.addTab());
  };

  constructor(host: HTMLElement, private opts: ChatOpts) {
    this.el = document.createElement("div");
    this.el.className = "ai-chat";
    this.el.innerHTML = `
      <div class="ai-ctabs-bar">
        <div class="ai-ctabs"></div>
        <button class="icon" data-c="tab-new" title="Новая вкладка чата">＋</button>
      </div>
      <div class="ai-cbind"><label title="Вопросы во вкладке идут про эту вкладку терминала или сервер: оттуда берётся папка и оболочка, туда вставляются команды, расследование идёт только на этом сервере">Привязка
        <select class="ai-bind"></select></label></div>
      <div class="ai-chat-logs"></div>
      <div class="ai-chat-in">
        <label class="check ai-agent-mode" hidden title="Агент сам сходит на хост и выполнит команды — в рамках того, что разрешено в разделе «ИИ-агент»">
          <input type="checkbox" data-c="agent" /><span>Расследование</span></label>
        <textarea rows="2" placeholder="Вопрос… (Enter — отправить, Shift+Enter — новая строка)" spellcheck="false"></textarea>
        <div class="ai-chat-btns">
          <button class="primary" data-c="send">Отправить</button>
          <button class="ghost" data-c="clear" title="Начать разговор в этой вкладке заново">Новый</button>
        </div>
      </div>`;
    host.appendChild(this.el);
    this.logs = this.el.querySelector(".ai-chat-logs")!;
    this.tabsEl = this.el.querySelector(".ai-ctabs")!;
    this.bindSel = this.el.querySelector(".ai-bind")!;
    this.input = this.el.querySelector("textarea")!;
    this.sendBtn = this.el.querySelector("[data-c=send]")!;
    this.select(this.addTab());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.submit(); }
    });
    // режим расследования показываем, только если агент включён в своём разделе
    invoke<Policy>("agent_policy")
      .then((p) => { this.policy = p; this.el.querySelector<HTMLElement>(".ai-agent-mode")!.hidden = !p.enabled; })
      .catch(() => {});
    // список привязок собирается, когда его открывают: вкладки терминала и хосты меняются
    this.bindSel.addEventListener("mousedown", () => this.fillBind());
    this.bindSel.addEventListener("focus", () => this.fillBind());
    this.bindSel.addEventListener("change", () => this.bindChanged());
    this.fillBind();
    this.opts.hosts?.().then((h) => { this.hosts = h; this.fillBind(); }).catch(() => {});
    this.el.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-c]");
      if (!b) return;
      const code = () => b.closest(".ai-code")?.querySelector("code")?.textContent ?? "";
      const tab = this.tabs.find((t) => t.btn.contains(b));
      switch (b.dataset.c) {
        case "send": return this.busy ? this.stop() : this.submit();
        case "clear": return this.clear();
        case "tab-new": {
          if (this.tabs.length >= MAX_CHAT_TABS) return toast(`${t("Не больше")} ${MAX_CHAT_TABS} ${t("вкладок чата")}`, "err");
          this.select(this.addTab());
          this.save();
          return this.input.focus();
        }
        case "tab": if (tab) { this.select(tab); this.save(); } return;
        case "tab-close": if (tab) this.closeTab(tab); return;
        case "insert": this.opts.insert(code(), this.target(this.cur)); return toast(t("Команда вставлена в терминал — проверьте и нажмите Enter"));
        case "copy": navigator.clipboard.writeText(code()).then(() => toast(t("Скопировано")), () => {}); return;
      }
    });
    this.tabsEl.addEventListener("dblclick", (e) => {
      const tab = this.tabs.find((t) => t.btn.contains(e.target as Node));
      if (tab) this.rename(tab);
    });
    window.addEventListener("ai-chat-history", this.onHistoryPref);
    window.addEventListener("ai-chat-forget", this.onForget);
    if (chatHistoryEnabled()) {
      invoke<Saved>("ai_chat_history_load").then((s) => this.restore(s)).catch(() => {});
    }
  }

  focus() { this.input.focus(); }
  resize() { /* layout is CSS only */ }

  /** Text from elsewhere (selection, logs, alerts, a note): goes into the question box. */
  paste(text: string) {
    this.input.value = this.input.value ? `${this.input.value}\n\n${text}` : text;
    this.input.focus();
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }

  dispose() {
    this.stop();
    // то, что ждало записи, не теряется при закрытии панели или перезапуске агента
    if (this.saveTimer) this.saveNow();
    window.removeEventListener("ai-chat-history", this.onHistoryPref);
    window.removeEventListener("ai-chat-forget", this.onForget);
    this.el.remove();
  }

  // ----- привязка к вкладкам терминала: терминал сообщает о них сам -----

  /** Активная вкладка терминала сменилась: если к ней привязана вкладка чата — открыть её. */
  terminalTabShown(id: string) {
    if (this.cur.bind?.kind === "tab" && this.cur.bind.id === id) return;
    const bound = this.tabs.find((t) => t.bind?.kind === "tab" && t.bind.id === id);
    if (bound) this.select(bound);
  }

  /** Вкладку терминала закрыли или унесли в другое окно; `into` — её панели перешли в эту вкладку. */
  terminalTabGone(id: string, into?: { id: string; title: string }) {
    for (const tab of this.tabs) {
      if (tab.bind?.kind !== "tab" || tab.bind.id !== id) continue;
      if (into) {
        tab.bind = { kind: "tab", id: into.id, title: into.title };
      } else {
        const was = tab.bind.title;
        tab.bind = null;
        this.note(tab, `${t("Вкладка терминала")} «${was}» ${t("закрыта — привязка снята")}`);
      }
    }
    this.fillBind();
  }

  // ----- вкладки чата -----

  private addTab(saved?: Saved["tabs"][number]): ChatTab {
    this.seq++;
    const log = document.createElement("div");
    log.className = "ai-chat-log";
    log.hidden = true;
    log.innerHTML = `<p class="muted ai-chat-hello">Локальный ИИ OpsDeck: спросите про команды, ошибки, конфиги. Ответ генерируется на этом компьютере (или на вашем ИИ-сервере из ⚙ Настройки). Команды из ответа вставляются в терминал кнопкой — сами не выполняются.</p>`;
    this.logs.appendChild(log);
    const btn = document.createElement("div");
    btn.className = "ai-ctab";
    btn.dataset.c = "tab";
    btn.title = t("Двойной клик — переименовать");
    btn.innerHTML = `<span class="ai-ctab-name"></span><span class="ai-ctab-x" data-c="tab-close" title="${esc(t("Закрыть вкладку чата"))}">×</span>`;
    this.tabsEl.appendChild(btn);
    const tab: ChatTab = {
      id: saved?.id || newId(),
      title: saved?.title || `${t("Чат")} ${this.seq}`,
      named: saved?.named ?? false,
      bind: saved?.server ? { kind: "server", key: saved.server.key, name: saved.server.name } : null,
      entries: [],
      log,
      btn,
    };
    this.tabs.push(tab);
    this.label(tab);
    for (const e of saved?.entries ?? []) this.show(tab, e);
    return tab;
  }

  private label(tab: ChatTab) {
    tab.btn.querySelector(".ai-ctab-name")!.textContent = tab.title;
    const b = tab.bind;
    tab.btn.classList.toggle("bound", !!b);
    tab.btn.title = `${b ? `${b.kind === "tab" ? t("Вкладка терминала") : t("Сервер")}: ${b.kind === "tab" ? b.title : b.name}. ` : ""}${t("Двойной клик — переименовать")}`;
  }

  private select(tab: ChatTab) {
    this.cur = tab;
    for (const x of this.tabs) {
      x.log.hidden = x !== tab;
      x.btn.classList.toggle("cur", x === tab);
    }
    this.fillBind();
    tab.btn.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private closeTab(tab: ChatTab) {
    if (this.busy?.tab === tab) this.stop();
    if (this.tabs.length === 1) return this.clear(); // последняя вкладка не исчезает — начинается заново
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    tab.btn.remove();
    tab.log.remove();
    if (this.cur === tab) this.select(this.tabs[Math.max(0, i - 1)]);
    this.save();
  }

  private async rename(tab: ChatTab) {
    const name = await ask(t("Название вкладки чата"), "", { input: tab.title });
    if (!name) return;
    tab.title = name.slice(0, 80);
    tab.named = true;
    this.label(tab);
    this.save();
  }

  /** Сохранённые вкладки — если до их прихода ничего не спросили (иначе остаётся то, что на экране). */
  private restore(s: Saved) {
    if (this.touched || !s?.tabs?.length) return;
    this.tabs.splice(0).forEach((x) => { x.btn.remove(); x.log.remove(); });
    this.seq = 0;
    for (const saved of s.tabs.slice(0, MAX_CHAT_TABS)) this.addTab(saved);
    this.select(this.tabs.find((x) => x.id === s.current) ?? this.tabs[0]);
  }

  // ----- привязка -----

  private target(tab: ChatTab): ChatTarget | undefined {
    const b = tab.bind;
    if (!b) return undefined;
    return b.kind === "tab" ? { tab: b.id } : { server: { key: b.key, name: b.name } };
  }

  private fillBind() {
    const sel = this.bindSel;
    const b = this.cur?.bind ?? null;
    const value = !b ? "" : b.kind === "tab" ? `tab:${b.id}` : `server:${b.key}`;
    const opt = (v: string, text: string) => `<option value="${esc(v)}">${esc(text)}</option>`;
    const termTabs = this.opts.terminalTabs?.() ?? [];
    if (b?.kind === "tab" && !termTabs.some((x) => x.id === b.id)) termTabs.push({ id: b.id, title: b.title });
    const hosts = [...this.hosts];
    if (b?.kind === "server" && !hosts.some((h) => h.key === b.key)) hosts.push({ key: b.key, name: b.name });
    sel.innerHTML = opt("", t("без привязки — активная вкладка терминала"))
      + (termTabs.length ? `<optgroup label="${esc(t("Вкладка терминала"))}">${termTabs.map((x) => opt(`tab:${x.id}`, x.title)).join("")}</optgroup>` : "")
      + (hosts.length ? `<optgroup label="${esc(t("Сервер"))}">${hosts.map((h) => opt(`server:${h.key}`, h.name)).join("")}</optgroup>` : "");
    sel.value = value;
    if (this.cur) this.label(this.cur);
  }

  private bindChanged() {
    const v = this.bindSel.value;
    const tab = this.cur;
    if (v.startsWith("tab:")) {
      const id = v.slice(4);
      const title = this.opts.terminalTabs?.().find((x) => x.id === id)?.title ?? id;
      tab.bind = { kind: "tab", id, title };
    } else if (v.startsWith("server:")) {
      const key = v.slice(7);
      tab.bind = { kind: "server", key, name: this.hosts.find((h) => h.key === key)?.name ?? key };
    } else {
      tab.bind = null;
    }
    this.label(tab);
    this.save();
  }

  // ----- сохранение (#100) -----

  private save() {
    if (!chatHistoryEnabled()) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveNow(), 500);
  }

  private saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    if (!chatHistoryEnabled()) return;
    const chats: Saved = {
      // привязка к вкладке терминала после перезапуска не имеет смысла: вкладки будут другие
      tabs: this.tabs.map((x) => ({ id: x.id, title: x.title, named: x.named, server: x.bind?.kind === "server" ? { key: x.bind.key, name: x.bind.name } : null, entries: x.entries })),
      current: this.cur.id,
    };
    invoke("ai_chat_history_save", { chats }).catch((e) => toast(`${t("История чата не сохранена")}: ${e}`, "err"));
  }

  // ----- разговор -----

  /** Записать сообщение в разговор вкладки и показать его. */
  private push(tab: ChatTab, e: Entry) {
    tab.entries.push(e);
    if (e.role === "user" && !tab.named && tab.entries.filter((x) => x.role === "user").length === 1) {
      tab.title = titleFrom(e.content) || tab.title;
      this.label(tab);
    }
    this.save();
  }

  /** Сообщение из сохранённого разговора. */
  private show(tab: ChatTab, e: Entry) {
    tab.entries.push(e);
    const el = this.bubble(e.role, tab);
    if (e.agent && e.role === "assistant") {
      el.classList.add("agent");
      el.innerHTML = `<div class="ai-text muted">${esc(t("Расследование: шаги и вывод команд не сохраняются"))}</div><div class="ai-text ai-done">${inline(e.content)}</div>`;
    } else {
      this.render(el, e.content);
    }
  }

  private note(tab: ChatTab, text: string) {
    const p = document.createElement("p");
    p.className = "muted ai-chat-note";
    p.textContent = text;
    tab.log.appendChild(p);
  }

  private clear() {
    this.stop();
    const tab = this.cur;
    tab.entries = [];
    tab.log.querySelectorAll(".ai-msg, .ai-chat-note").forEach((m) => m.remove());
    if (!tab.named) { tab.title = `${t("Чат")} ${this.tabs.indexOf(tab) + 1}`; this.label(tab); }
    this.save();
    this.input.focus();
  }

  private stop() {
    this.stopped = true;
    if (!this.busy) return;
    invoke("ai_chat_stop", { id: this.busy.id }).catch(() => {});
  }

  private get agentMode() {
    return this.el.querySelector<HTMLInputElement>("[data-c=agent]")?.checked ?? false;
  }

  private bubble(role: "user" | "assistant", tab: ChatTab = this.cur): HTMLElement {
    const m = document.createElement("div");
    m.className = `ai-msg ${role}`;
    tab.log.appendChild(m);
    return m;
  }

  private render(el: HTMLElement, text: string) {
    el.innerHTML = parts(text).map((p) => p.kind === "text" ? `<div class="ai-text">${inline(p.body)}</div>`
      : `<div class="ai-code"><pre><code>${esc(p.body)}</code></pre>
          <div class="ai-code-btns"><button class="ghost" data-c="insert" title="Вставить в терминал (без Enter): в привязанную вкладку, иначе в активную">▸ В терминал</button><button class="ghost" data-c="copy">Копировать</button></div></div>`).join("");
    const log = el.closest<HTMLElement>(".ai-chat-log");
    if (log) log.scrollTop = log.scrollHeight;
  }

  /** Один ответ модели целиком: цикл расследования идёт по шагам, стримить тут нечего. */
  private askModel(tab: ChatTab, messages: ChatMsg[], hosts?: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const id = uid("chat");
      let answer = "";
      const ctx = this.opts.context(this.target(tab));
      const finish = (un: UnlistenFn[]) => { un.forEach((u) => u()); this.busy = null; };
      (async () => {
        const un: UnlistenFn[] = [
          await listen<{ text: string }>(`ai-chat-${id}`, (e) => { answer += e.payload.text; }),
          await listen<{ error: string | null }>(`ai-chat-done-${id}`, (e) => {
            finish(un);
            if (e.payload.error) reject(new Error(e.payload.error));
            else resolve(answer);
          }),
        ];
        this.busy = { id, un, tab };
        try {
          await invoke("ai_chat", { id, messages, cwd: ctx.cwd ?? null, shell: ctx.shell ?? null, hosts: hosts ?? null, server: null });
        } catch (e) {
          finish(un);
          reject(e);
        }
      })().catch(reject);
    });
  }

  /** Расследование: модель предлагает команду, политика решает, выполнять ли, вывод идёт обратно. */
  private async investigate(tab: ChatTab, question: string) {
    let hosts = (await this.opts.hosts?.().catch(() => [])) ?? [];
    const box = this.bubble("assistant", tab);
    box.classList.add("agent");
    const line = (html: string) => { box.insertAdjacentHTML("beforeend", html); tab.log.scrollTop = tab.log.scrollHeight; };
    this.push(tab, { role: "user", content: question, agent: true });
    // вкладка привязана к серверу — агент работает только на нём
    if (tab.bind?.kind === "server") {
      const key = tab.bind.key;
      hosts = hosts.filter((h) => h.key === key);
      if (!hosts.length) {
        const why = `${t("Сервера")} «${tab.bind.name}» ${t("нет в списке SSH — привяжите вкладку к другому")}`;
        line(`<div class="ai-text err">${esc(why)}</div>`);
        this.push(tab, { role: "assistant", content: why, agent: true });
        return;
      }
    }
    line(`<div class="ai-text muted">${esc(t("Иду на хост…"))}</div>`);
    this.sendBtn.textContent = t("Стоп");
    this.stopped = false;
    try {
      await investigate(question, {
        hosts,
        maxSteps: Math.max(1, this.policy?.max_steps ?? 12),
        stopped: () => this.stopped,
        ask: (messages) => this.askModel(tab, messages as ChatMsg[], hosts.map((h) => h.name)),
        check: (target, command) => invoke<Check>("agent_check", { target, command }),
        exec: (target, command, approved) => invoke<Run>("agent_exec", { target, command, approved }),
        confirm: async (host, command) =>
          (await ask(t("Выполнить на хосте?"), `${host}\n\n${command}\n\n${t("Эта команда меняет состояние хоста.")}`, { ok: t("Выполнить"), danger: true })) !== null,
        on: (e) => {
          line(this.stepHtml(e));
          // в разговоре остаётся итог: шаги и вывод команд — нет (там чаще всего лишнее и секреты)
          if (e.type === "done") this.push(tab, { role: "assistant", content: e.text, agent: true });
          if (e.type === "stopped") this.push(tab, { role: "assistant", content: e.why, agent: true });
        },
      });
    } catch (e) {
      line(`<div class="ai-text err">${esc(t(String(e)))}</div>`);
    }
    this.finish();
  }

  /** Шаг расследования в панели: что за команда, на каком хосте и чем кончилась. */
  private stepHtml(e: AgentEvent): string {
    switch (e.type) {
      case "step": {
        const mark = e.verdict.kind === "read" ? t("чтение") : e.verdict.kind === "write" ? t("изменение") : t("запрещено");
        const state = e.state === "ask" ? t("ждёт разрешения") : e.state === "denied" ? t("не выполнена") : t("выполняю");
        return `<div class="ai-step ${e.state}"><div class="ai-step-head"><b>${esc(e.host)}</b><span class="muted">${esc(mark)} · ${esc(state)}</span></div>
          <pre><code>${esc(e.command)}</code></pre></div>`;
      }
      case "result":
        return `<details class="ai-out${e.run.exit_code ? " err" : ""}"><summary>${t("вывод")} · ${t("код")} ${e.run.exit_code} · ${Math.round(e.run.took_ms / 100) / 10} ${t("сек")}</summary><pre>${esc(e.run.output)}</pre></details>`;
      case "denied":
        return `<div class="ai-text err">${esc(e.why)}</div>`;
      case "done":
        return `<div class="ai-text ai-done">${inline(e.text)}</div>`;
      case "stopped":
        return `<div class="ai-text muted">${esc(e.why)}</div>`;
    }
  }

  private async submit() {
    const q = this.input.value.trim();
    if (!q || this.busy) return;
    this.touched = true;
    this.input.value = "";
    const tab = this.cur;
    if (this.agentMode) {
      this.render(this.bubble("user", tab), q);
      return this.investigate(tab, q);
    }
    this.push(tab, { role: "user", content: q });
    this.render(this.bubble("user", tab), q);
    const out = this.bubble("assistant", tab);
    out.classList.add("pending");
    out.innerHTML = `<span class="muted">${esc(t("думаю…"))}</span>`;
    const id = uid("chat");
    let answer = "";
    const un = [
      await listen<{ text: string }>(`ai-chat-${id}`, (e) => { answer += e.payload.text; out.classList.remove("pending"); this.render(out, answer); }),
      await listen<{ error: string | null; elapsed_ms: number }>(`ai-chat-done-${id}`, (e) => {
        out.classList.remove("pending");
        if (e.payload.error) {
          out.classList.add("error");
          out.innerHTML = `<div class="ai-text err">${esc(t(e.payload.error))}</div>`;
        } else if (!answer) {
          out.innerHTML = `<span class="muted">${esc(t("остановлено"))}</span>`;
        }
        if (answer) this.push(tab, { role: "assistant", content: answer });
        this.finish();
      }),
    ];
    this.busy = { id, un, tab };
    this.sendBtn.textContent = t("Стоп");
    const target = this.target(tab);
    const ctx = this.opts.context(target);
    try {
      await invoke("ai_chat", { id, messages: modelHistory(tab.entries), cwd: ctx.cwd ?? null, shell: ctx.shell ?? null, server: target?.server?.name ?? null });
    } catch (e) {
      out.classList.remove("pending");
      out.classList.add("error");
      out.innerHTML = `<div class="ai-text err">${esc(t(String(e)))}</div>`;
      tab.entries.pop();
      this.save();
      this.finish();
    }
  }

  private finish() {
    this.busy?.un.forEach((u) => u());
    this.busy = null;
    this.sendBtn.textContent = t("Отправить");
    this.input.focus();
  }
}
