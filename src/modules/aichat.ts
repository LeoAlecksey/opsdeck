/**
 * The local AI as a chat in the terminal's AI panel: the built-in model (or the external server from
 * Settings → Local AI). Answers stream in; commands in ``` blocks get «В терминал» (inserted into the
 * active pane without Enter — nothing runs by itself) and «Копировать».
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { esc, toast } from "./ui";
import { t } from "../i18n";

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

let seq = 0;

export type ChatOpts = {
  /** context sent with each question */
  context: () => { cwd?: string; shell?: string | null };
  /** puts a command into the active terminal pane (no Enter) */
  insert: (cmd: string) => void;
};

export class LocalChat {
  readonly el: HTMLElement;
  private history: ChatMsg[] = [];
  private busy: { id: string; un: UnlistenFn[] } | null = null;
  private log: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;

  constructor(host: HTMLElement, private opts: ChatOpts) {
    this.el = document.createElement("div");
    this.el.className = "ai-chat";
    this.el.innerHTML = `
      <div class="ai-chat-log"><p class="muted ai-chat-hello">Локальный ИИ OpsDeck: спросите про команды, ошибки, конфиги. Ответ генерируется на этом компьютере (или на вашем ИИ-сервере из ⚙ Настройки). Команды из ответа вставляются в терминал кнопкой — сами не выполняются.</p></div>
      <div class="ai-chat-in">
        <textarea rows="2" placeholder="Вопрос… (Enter — отправить, Shift+Enter — новая строка)" spellcheck="false"></textarea>
        <div class="ai-chat-btns">
          <button class="primary" data-c="send">Отправить</button>
          <button class="ghost" data-c="clear" title="Начать новый разговор">Новый</button>
        </div>
      </div>`;
    host.appendChild(this.el);
    this.log = this.el.querySelector(".ai-chat-log")!;
    this.input = this.el.querySelector("textarea")!;
    this.sendBtn = this.el.querySelector("[data-c=send]")!;
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.submit(); }
    });
    this.el.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-c]");
      if (!b) return;
      const code = () => b.closest(".ai-code")?.querySelector("code")?.textContent ?? "";
      switch (b.dataset.c) {
        case "send": return this.busy ? this.stop() : this.submit();
        case "clear": return this.clear();
        case "insert": this.opts.insert(code()); return toast(t("Команда вставлена в терминал — проверьте и нажмите Enter"));
        case "copy": navigator.clipboard.writeText(code()).then(() => toast(t("Скопировано")), () => {}); return;
      }
    });
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
    this.el.remove();
  }

  private clear() {
    this.stop();
    this.history = [];
    this.log.querySelectorAll(".ai-msg").forEach((m) => m.remove());
    this.input.focus();
  }

  private stop() {
    if (!this.busy) return;
    invoke("ai_chat_stop", { id: this.busy.id }).catch(() => {});
  }

  private bubble(role: "user" | "assistant"): HTMLElement {
    const m = document.createElement("div");
    m.className = `ai-msg ${role}`;
    this.log.appendChild(m);
    return m;
  }

  private render(el: HTMLElement, text: string) {
    el.innerHTML = parts(text).map((p) => p.kind === "text" ? `<div class="ai-text">${inline(p.body)}</div>`
      : `<div class="ai-code"><pre><code>${esc(p.body)}</code></pre>
          <div class="ai-code-btns"><button class="ghost" data-c="insert" title="Вставить в активную вкладку терминала (без Enter)">▸ В терминал</button><button class="ghost" data-c="copy">Копировать</button></div></div>`).join("");
    this.log.scrollTop = this.log.scrollHeight;
  }

  private async submit() {
    const q = this.input.value.trim();
    if (!q || this.busy) return;
    this.input.value = "";
    this.history.push({ role: "user", content: q });
    this.render(this.bubble("user"), q);
    const out = this.bubble("assistant");
    out.classList.add("pending");
    out.innerHTML = `<span class="muted">${esc(t("думаю…"))}</span>`;
    const id = `chat${++seq}`;
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
        if (answer) this.history.push({ role: "assistant", content: answer });
        this.finish();
      }),
    ];
    this.busy = { id, un };
    this.sendBtn.textContent = t("Стоп");
    const ctx = this.opts.context();
    try {
      await invoke("ai_chat", { id, messages: [...this.history], cwd: ctx.cwd ?? null, shell: ctx.shell ?? null });
    } catch (e) {
      out.classList.remove("pending");
      out.classList.add("error");
      out.innerHTML = `<div class="ai-text err">${esc(t(String(e)))}</div>`;
      this.history.pop();
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
