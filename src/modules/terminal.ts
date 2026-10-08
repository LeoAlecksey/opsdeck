import { helpBtn } from "./help";
import { icon } from "./icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PtyTerminal, SpawnOpts, termFontSize, termFontStep } from "./pty";
import { Block, fmtDuration } from "./blocks";
import { registerProvider } from "./palette";
import { hlPrefs, setHlPrefs } from "./highlight";
import { addSnippet } from "./snippets";
import { attachPathLinks, mountFiles } from "./files";
import { esc, overlay, toast } from "./ui";
import { t } from "../i18n";
import { isWindows } from "./themes";
import { AI_PROVIDERS, aiAgent, setAiAgent } from "./ai-agents";
import { LocalChat } from "./aichat";
import { isWsl, shellName } from "./shellkind";

/** Other modules open a tab via: window.dispatchEvent(new CustomEvent("open-terminal", { detail })) */
export type OpenTerminalDetail = SpawnOpts & { title?: string; keepOpen?: boolean };

/** `spawn`: what runs in the pane (started again on reconnect); `exited`: a kept-open pane whose
 *  process ended; `lastConn`: the last failed connection command typed in a shell (ssh, kubectl exec…) */
type Pane = { pty: PtyTerminal; el: HTMLElement; tab: Tab; keepOpen: boolean; recording?: string; spawn: SpawnOpts; exited?: boolean; lastConn?: string };

/** Commands that connect somewhere: when one fails, «⟳ Повторить» / Ctrl+Shift+R run it again. */
export const CONNECT_CMD = /^\s*(sudo\s+)?(ssh|mosh|telnet|sftp|autossh|kubectl\s+(exec|attach|port-forward|logs\s+-f)|docker\s+(exec|attach)|podman\s+exec|wsl)\b/;
type Tab = { btn: HTMLElement; host: HTMLElement; label: HTMLElement; panes: Pane[]; active: Pane | null; dir: "row" | "column" };

const MAX_PANES = 4;

function load(key: string, fallback: string) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

/** Small API for the command palette and other modules. */
export const terminalApi = {
  active: null as PtyTerminal | null,
  paste(text: string) {
    const t = terminalApi.active;
    if (!t) return;
    window.dispatchEvent(new CustomEvent("show-view", { detail: "terminal" }));
    t.term.paste(text);
    t.term.focus();
  },
  history(): Block[] {
    return [...(terminalApi.active?.blocks.blocks ?? [])].reverse();
  },
};

export function mountTerminal(root: HTMLElement) {
  root.classList.add("terminal-view");
  root.innerHTML = `
    <aside class="files-panel" hidden></aside>
    <div class="term-main">
      <div class="tabbar">
        <button class="icon" data-act="files" title="Файлы: дерево текущей папки, открыть в IDE (Ctrl+Shift+B)">${icon("folder", 16)}</button>
        <div class="tabs"></div>
        <button class="icon" data-act="new" title="Новая вкладка (Ctrl+Shift+T)">${icon("plus", 16)}</button>
        <button class="icon wsl-btn" data-act="wsl" title="Новая вкладка WSL: выбрать дистрибутив" hidden>WSL</button>
        <button class="icon" data-act="split-r" title="Разделить вправо (Ctrl+Shift+D)">${icon("splitH", 16)}</button>
        <button class="icon" data-act="split-d" title="Разделить вниз (Ctrl+Shift+E)">${icon("splitV", 16)}</button>
        <button class="icon rec-btn" data-act="rec" title="Записывать эту панель в файл (вкл/выкл)">${icon("record", 16)}</button>
        <button class="icon" data-act="records" title="Открыть папку с записями сессий">${icon("folderOpen", 16)}</button>
        <span class="font-ctl" title="Размер шрифта терминала: Ctrl+= / Ctrl+- / Ctrl+0, или Ctrl+колесо">
          <button class="icon" data-act="font-down">A−</button><span class="font-size"></span><button class="icon" data-act="font-up">A+</button>
        </span>
        <span class="spacer"></span>
        <span class="ide-status" title="Claude Code IDE-мост"></span>
        ${helpBtn("terminal")}
        <button class="ghost" data-act="ask-ai" title="Локальный ИИ: опишите словами, что сделать, — получите команду (Ctrl+Shift+K)">${icon("sparkles", 16)}<span class="lbl"> ИИ</span></button>
        <button class="ghost" data-act="palette" title="Палитра команд (Ctrl+Shift+P)">${icon("command", 16)}<span class="lbl"> Команды</span></button>
        <button class="ghost" data-act="send" title="Отправить выделение в AI (Ctrl+Shift+A)">⇢<span class="lbl"> в AI</span></button>
        <button class="ghost" data-act="ai" title="Показать/скрыть AI-панель (Ctrl+Shift+I)">AI ▸</button>
      </div>
      <div class="term-hosts"></div>
      <div class="ai-ask" hidden>
        <div class="aa-row"><span class="aa-icon">${icon("sparkles", 16)}</span><input class="aa-in" placeholder="Что сделать? Например: перезапусти деплоймент api в stage — Enter" spellcheck="false" autocomplete="off" />
          <button class="icon" data-aa="close" title="Закрыть (Esc)">${icon("close", 16)}</button></div>
        <div class="aa-out" hidden>
          <pre class="aa-cmd"></pre>
          <div class="aa-acts"><button class="primary" data-aa="paste" title="Вставить в терминал, не выполняя (Enter)">Вставить</button>
            <button data-aa="run" title="Вставить и выполнить (Ctrl+Enter)">Выполнить</button>
            <button class="ghost" data-aa="again" title="Спросить ещё раз">${icon("refresh", 16)}</button>
            <span class="aa-meta muted"></span></div>
        </div>
      </div>
      <div class="sysbar" title="Ресурсы машины, на которой вы работаете: этой или удалённой в активной SSH-вкладке"></div>
    </div>
    <div class="splitter" hidden></div>
    <aside class="ai-panel" hidden>
      <div class="tabbar">
        <select class="ai-provider"></select>
        <span class="spacer"></span>
        <button class="icon" data-act="ai-restart" title="Перезапустить">${icon("refresh", 16)}</button>
      </div>
      <div class="ai-host"></div>
    </aside>`;

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const tabsEl = $(".tabs"), hostsEl = $(".term-hosts"), aiPanel = $(".ai-panel"), aiHost = $(".ai-host");
  // narrow tab bar (AI panel open, small window): collapse labels, then hide secondary buttons
  {
    const bar = $(".term-main > .tabbar");
    new ResizeObserver(() => {
      const w = bar.clientWidth;
      if (!w) return;
      bar.classList.toggle("w1", w < 1150);
      bar.classList.toggle("w2", w < 800);
      bar.classList.toggle("w3", w < 580);
    }).observe(bar);
  }
  // tabs that don't fit scroll horizontally with a plain wheel (the scrollbar itself is hidden)
  tabsEl.addEventListener("wheel", (e) => {
    if (tabsEl.scrollWidth <= tabsEl.clientWidth) return;
    e.preventDefault();
    tabsEl.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  }, { passive: false });
  const splitter = $(".splitter"), providerSel = $<HTMLSelectElement>(".ai-provider");

  const tabs: Tab[] = [];
  let activeTab: Tab | null = null;
  const filesPanel = $(".files-panel");
  /** what the AI panel holds: an agent's CLI in a terminal, or the local AI chat */
  type AiPane = { dispose(): void; resize(): void; paste(text: string): void; focus(): void };
  let ai: AiPane | null = null;

  for (const name of Object.keys(AI_PROVIDERS)) providerSel.add(new Option(name, name));
  providerSel.value = aiAgent();
  // the default agent changed in Settings or the palette: a running panel switches to it
  window.addEventListener("ai-agent", () => {
    if (providerSel.value === aiAgent()) return;
    providerSel.value = aiAgent();
    if (ai) startAi();
  });

  const activePane = () => activeTab?.active ?? null;
  // a WSL pane reports Linux paths: they are no use as a Windows working folder
  const cwd = () => { const p = activePane()?.pty; return p && !isWsl(p.launched) ? p.blocks.cwd || undefined : undefined; };

  // ----- session recording -----

  function syncRec() {
    const p = activePane();
    const btn = $("[data-act=rec]");
    btn.classList.toggle("on", !!p?.recording);
    btn.title = p?.recording ? `Идёт запись в ${p.recording} — нажмите, чтобы остановить` : "Записывать эту панель в файл (вкл/выкл)";
    for (const t of tabs) t.btn.classList.toggle("rec", t.panes.some((x) => x.recording));
  }

  async function toggleRec() {
    const p = activePane();
    if (!p) return;
    try {
      if (p.recording) {
        const path = await invoke<string | null>("pty_record_stop", { id: p.pty.id });
        p.recording = undefined;
        if (path) toast(`Запись сохранена: ${path}`);
      } else {
        p.recording = await invoke<string>("pty_record_start", { id: p.pty.id, title: p.tab.label.textContent || "terminal" });
        toast(`Запись идёт: ${p.recording}`);
      }
    } catch (e) { toast(String(e), "err"); }
    syncRec();
  }

  function focusPane(p: Pane) {
    p.tab.active = p;
    p.tab.panes.forEach((x) => x.el.classList.toggle("focused", x === p && p.tab.panes.length > 1));
    terminalApi.active = p.pty;
    syncRec();
  }

  function activate(t: Tab) {
    activeTab = t;
    for (const x of tabs) {
      x.host.hidden = x !== t;
      x.btn.classList.toggle("active", x === t);
    }
    t.btn.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (t.active) focusPane(t.active);
    requestAnimationFrame(() => { t.panes.forEach((p) => p.pty.resize()); t.active?.pty.term.focus(); });
  }

  // ----- panes -----

  function addPane(tab: Tab, opts: OpenTerminalDetail = {}) {
    const { title, keepOpen, ...spawn } = opts;
    const el = document.createElement("div");
    el.className = "pane";
    el.innerHTML = `<div class="pane-term"></div>
      <div class="blk-bar" hidden>
        <span class="blk-status"></span>
        <button data-b="cmd" title="Скопировать команду">⧉ команда</button>
        <button data-b="out" title="Скопировать вывод">⧉ вывод</button>
        <button data-b="save" title="Сохранить команду как сниппет">★</button>
        <button data-b="ai" title="Отправить команду и вывод в AI">⇢ AI</button>
      </div>
      <div class="fail-chip" hidden><span class="fail-text"></span>
        <button data-f="retry" class="primary" hidden title="Ctrl+Shift+R">⟳ Повторить</button>
        <button data-f="ai" class="primary">⇢ спросить AI</button><button data-f="x" class="icon">${icon("close", 14)}</button></div>
      <div class="reconnect-bar" hidden><span class="reconnect-text">Соединение закрыто</span>
        <button data-rc="go" class="primary" title="Enter или Ctrl+Shift+R">⟳ Переподключить</button>
        <button data-rc="close" class="ghost" title="Ctrl+Shift+W">Закрыть</button></div>`;
    tab.host.appendChild(el);

    const pane: Pane = { pty: null as unknown as PtyTerminal, el, tab, keepOpen: !!keepOpen, spawn };
    tab.panes.push(pane);
    if (title) tab.label.textContent = title;
    mountPty(pane);
    wireBlocks(pane);
    el.querySelector<HTMLElement>(".reconnect-bar")!.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-rc]")?.dataset.rc;
      if (a === "go") reconnect(pane);
      if (a === "close") closePane(pane);
    });
    // Enter in a pane whose connection closed: connect again
    el.addEventListener("keydown", (e) => {
      if (pane.exited && e.key === "Enter" && !e.ctrlKey && !e.altKey && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); reconnect(pane); }
    }, true);
    focusPane(pane);
    requestAnimationFrame(() => { tab.panes.forEach((p) => p.pty.resize()); pane.pty.term.focus(); });
    return pane;
  }

  /** (Re)starts the pane's process in its terminal area. */
  function mountPty(pane: Pane) {
    const area = pane.el.querySelector<HTMLElement>(".pane-term")!;
    area.innerHTML = "";
    const pty = new PtyTerminal(area, pane.spawn);
    pane.pty = pty;
    pane.exited = false;
    attachPathLinks(pty);
    pty.term.onTitleChange((t) => { if (pane.tab.active === pane && t) pane.tab.label.textContent = t; });
    pty.term.textarea?.addEventListener("focus", () => focusPane(pane));
    // a connection tab stays open when it ends: the reason is on screen, and it can be reconnected
    pty.onExit = () => {
      if (!pane.keepOpen) return closePane(pane);
      pane.exited = true;
      const bar = pane.el.querySelector<HTMLElement>(".reconnect-bar")!;
      bar.querySelector(".reconnect-text")!.textContent = pane.spawn.program ? `${t("Соединение закрыто")}: ${[pane.spawn.program, ...(pane.spawn.args ?? [])].join(" ").slice(0, 80)}` : t("Сессия завершена");
      bar.hidden = false;
    };
    listen<string>(`pty-record-${pty.id}`, (e) => {
      if (!pane.recording) return;
      pane.recording = undefined;
      toast(`Сессия завершилась, запись сохранена: ${e.payload}`);
      syncRec();
    });
    wireFailChip(pane);
  }

  function reconnect(pane: Pane) {
    pane.el.querySelector<HTMLElement>(".reconnect-bar")!.hidden = true;
    pane.el.querySelector<HTMLElement>(".fail-chip")!.hidden = true;
    pane.pty.dispose();
    mountPty(pane);
    requestAnimationFrame(() => { pane.pty.resize(); pane.pty.term.focus(); });
  }

  /** Ctrl+Shift+R: a closed connection tab reconnects; in a shell, the failed ssh/kubectl exec runs again. */
  function retry(pane: Pane) {
    if (pane.exited) return reconnect(pane);
    if (!pane.lastConn) return toast(t("Нечего переподключать: нет оборвавшегося соединения"));
    pane.el.querySelector<HTMLElement>(".fail-chip")!.hidden = true;
    pane.pty.send(pane.lastConn + "\r");
    pane.pty.term.focus();
  }

  function closePane(p: Pane) {
    const tab = p.tab;
    const i = tab.panes.indexOf(p);
    if (i < 0) return;
    tab.panes.splice(i, 1);
    p.pty.dispose();
    p.el.remove();
    if (!tab.panes.length) return closeTab(tab);
    focusPane(tab.panes[Math.max(0, i - 1)]);
    requestAnimationFrame(() => { tab.panes.forEach((x) => x.pty.resize()); tab.active?.pty.term.focus(); });
  }

  function split(dir: "row" | "column") {
    const tab = activeTab;
    if (!tab) return;
    if (tab.panes.length >= MAX_PANES) return toast(`Не больше ${MAX_PANES} панелей во вкладке`, "err");
    if (tab.panes.length > 1 && tab.dir !== dir) return toast("Во вкладке уже есть разделение в другую сторону", "err");
    tab.dir = dir;
    tab.host.style.flexDirection = dir;
    // like Windows Terminal: a WSL pane splits into the same distribution, others into a local shell
    const l = tab.active?.pty.launched ?? null;
    addPane(tab, l && isWsl(l) ? { program: l.program, args: l.args } : { cwd: cwd() });
  }

  function cyclePane(step: 1 | -1) {
    const tab = activeTab;
    if (!tab?.active || tab.panes.length < 2) return;
    const i = (tab.panes.indexOf(tab.active) + step + tab.panes.length) % tab.panes.length;
    focusPane(tab.panes[i]);
    tab.panes[i].pty.term.focus();
  }

  // ----- tabs -----

  function closeTab(t: Tab) {
    const i = tabs.indexOf(t);
    if (i < 0) return;
    tabs.splice(i, 1);
    t.panes.splice(0).forEach((p) => p.pty.dispose());
    t.btn.remove();
    t.host.remove();
    if (!tabs.length) newTab();
    else if (activeTab === t) activate(tabs[Math.max(0, i - 1)]);
  }

  function newTab(opts: OpenTerminalDetail = {}) {
    const host = document.createElement("div");
    host.className = "term-host";
    hostsEl.appendChild(host);
    const btn = document.createElement("div");
    btn.className = "tab";
    btn.innerHTML = `<span class="label"></span><span class="x" title="Закрыть">×</span>`;
    tabsEl.appendChild(btn);
    const label = btn.querySelector<HTMLElement>(".label")!;
    label.textContent = `shell ${tabs.length + 1}`;
    const tab: Tab = { btn, host, label, panes: [], active: null, dir: "row" };
    btn.onclick = () => activate(tab);
    btn.querySelector<HTMLElement>(".x")!.onclick = (e) => { e.stopPropagation(); closeTab(tab); };
    tabs.push(tab);
    // a plain new tab starts where the current one is
    addPane(tab, opts.program ? opts : { cwd: cwd(), ...opts });
    activate(tab);
  }

  // ----- command blocks -----

  function blockText(p: Pane, b: Block, lines = 150) {
    return p.pty.blocks.output(b, lines);
  }

  function askAi(p: Pane, b: Block) {
    const out = blockText(p, b);
    const status = b.exit === 0 ? "завершилась успешно" : `завершилась с кодом ${b.exit}`;
    sendToAi(`Команда в терминале ${status}${p.pty.blocks.cwd ? ` (каталог ${p.pty.blocks.cwd})` : ""}:\n$ ${b.command}\n\nВывод:\n\`\`\`\n${out || "(пусто)"}\n\`\`\`\n${b.exit === 0 ? "Поясни результат." : "Объясни причину ошибки и как исправить."}`);
  }

  function wireBlocks(p: Pane) {
    const bar = p.el.querySelector<HTMLElement>(".blk-bar")!;
    const chip = p.el.querySelector<HTMLElement>(".fail-chip")!;
    const termEl = p.el.querySelector<HTMLElement>(".pane-term")!;
    let hovered: Block | undefined;

    termEl.addEventListener("mousemove", (e) => {
      const screen = termEl.querySelector<HTMLElement>(".xterm-screen");
      if (!screen || !p.pty.blocks.active) return;
      const r = screen.getBoundingClientRect();
      const cellH = r.height / p.pty.term.rows;
      const row = Math.floor((e.clientY - r.top) / cellH);
      const vp = p.pty.term.buffer.active.viewportY;
      const b = p.pty.blocks.at(vp + row);
      if (!b || b.prompt.line < vp) { bar.hidden = true; hovered = undefined; return; }
      hovered = b;
      bar.hidden = false;
      bar.style.top = `${r.top - p.el.getBoundingClientRect().top + (b.prompt.line - vp) * cellH}px`;
      const ok = b.exit === 0;
      const st = bar.querySelector<HTMLElement>(".blk-status")!;
      st.textContent = `${ok ? "✓" : `✗ ${b.exit}`} · ${fmtDuration(b.duration)}`;
      st.className = `blk-status ${ok ? "ok" : "bad"}`;
    });
    p.el.addEventListener("mouseleave", () => (bar.hidden = true));

    bar.addEventListener("click", async (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-b]")?.dataset.b;
      const b = hovered;
      if (!act || !b) return;
      if (act === "cmd") { await invoke("clip_write", { text: b.command }); toast("Команда скопирована"); }
      if (act === "out") { await invoke("clip_write", { text: blockText(p, b, 5000) }); toast("Вывод скопирован"); }
      if (act === "save") addSnippet(b.command);
      if (act === "ai") askAi(p, b);
    });

    chip.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-f]")?.dataset.f;
      if (act === "ai" && failed.get(p)) askAi(p, failed.get(p)!);
      if (act === "retry") return retry(p);
      if (act) chip.hidden = true;
    });
  }

  const failed = new WeakMap<Pane, Block>();
  /** The «✗ command — code N» chip of the pane's current terminal. */
  function wireFailChip(p: Pane) {
    const chip = p.el.querySelector<HTMLElement>(".fail-chip")!;
    let chipTimer = 0;
    p.pty.blocks.onFinished = (b) => {
      // 130 = Ctrl+C, 148 = Ctrl+Z: the user stopped it on purpose
      if (b.exit === 0 || b.exit === 130 || b.exit === 148) { chip.hidden = true; return; }
      failed.set(p, b);
      const conn = CONNECT_CMD.test(b.command);
      p.lastConn = conn ? b.command : p.lastConn;
      chip.querySelector(".fail-text")!.textContent = `✗ «${b.command.length > 40 ? b.command.slice(0, 40) + "…" : b.command}» — код ${b.exit}`;
      chip.querySelector<HTMLElement>("[data-f=retry]")!.hidden = !conn;
      chip.hidden = false;
      clearTimeout(chipTimer);
      // a dropped connection keeps its chip: there is something to do about it
      if (!conn) chipTimer = window.setTimeout(() => (chip.hidden = true), 12000);
    };
  }

  // ----- files panel -----

  const files = mountFiles(filesPanel, {
    cwd: () => cwd(),
    paste: (text) => { const t = activePane()?.pty; if (t) { t.term.paste(text); t.term.focus(); } },
  });

  function toggleFiles(force?: boolean) {
    const show = force ?? filesPanel.hidden;
    filesPanel.hidden = !show;
    save("opsdeck.files.open", show ? "1" : "0");
    $("[data-act=files]").classList.toggle("on", show);
    if (show) files.shown();
    requestAnimationFrame(() => activeTab?.panes.forEach((p) => p.pty.resize()));
  }

  // ----- AI panel -----

  function startAi() {
    ai?.dispose();
    aiHost.innerHTML = "";
    const p = AI_PROVIDERS[providerSel.value];
    if (p.local) {
      ai = new LocalChat(aiHost, {
        context: () => ({ cwd: cwd(), shell: shellName(activePane()?.pty.launched ?? null) }),
        // into the active pane, as a bracketed paste: multi-line stays one input, no Enter
        insert: (cmd) => { const pane = activePane(); if (!pane) return; pane.pty.send(`\x1b[200~${cmd}\x1b[201~`); pane.pty.term.focus(); },
      });
      return;
    }
    const pty = new PtyTerminal(aiHost, { program: p.program, args: p.args, cwd: cwd() });
    ai = { dispose: () => pty.dispose(), resize: () => pty.resize(), focus: () => pty.term.focus(), paste: (text) => { pty.send(`\x1b[200~${text}\x1b[201~`); } };
  }

  function toggleAi(force?: boolean) {
    const show = force ?? aiPanel.hidden;
    aiPanel.hidden = !show;
    splitter.hidden = !show;
    if (show && !ai) startAi();
    requestAnimationFrame(() => {
      activeTab?.panes.forEach((p) => p.pty.resize());
      ai?.resize();
      if (show) ai?.focus(); else activePane()?.pty.term.focus();
    });
  }

  function sendSelection() {
    const sel = activePane()?.pty.term.getSelection().trim();
    if (sel) sendToAi(sel);
  }

  function sendToAi(text: string) {
    const fresh = !ai;
    toggleAi(true);
    // bracketed paste so multi-line text lands as one message instead of being submitted line by line
    // a CLI agent needs a moment to start before it takes input; the chat takes it at once
    const local = AI_PROVIDERS[providerSel.value]?.local;
    setTimeout(() => ai?.paste(text), fresh && !local ? 1500 : 0);
    ai?.focus();
  }

  splitter.addEventListener("pointerdown", (e) => {
    splitter.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const w = Math.min(Math.max(root.getBoundingClientRect().right - ev.clientX, 280), root.clientWidth - 320);
      aiPanel.style.width = `${w}px`;
    };
    const up = () => {
      splitter.removeEventListener("pointermove", move);
      save("opsdeck.ai.width", aiPanel.style.width);
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up, { once: true });
  });
  aiPanel.style.width = load("opsdeck.ai.width", "520px");

  // ----- resource bar: this machine, or the remote host of the active SSH session -----

  type Stats = {
    host: string; remote: boolean; cpu: number | null; cores: number; load: number[] | null;
    mem_used: number; mem_total: number; swap_used: number; swap_total: number;
    disk_mount: string; disk_used: number; disk_total: number; uptime: number;
  };
  const sysbar = $(".sysbar");
  const gb = (b: number) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : `${(b / 1e9).toFixed(1)} GB`);
  const lvl = (pct: number) => (pct >= 90 ? "bad" : pct >= 75 ? "warn" : "");
  const upt = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)}д ${Math.floor((s % 86400) / 3600)}ч` : `${Math.floor(s / 3600)}ч ${Math.floor((s % 3600) / 60)}м`);

  /** ssh destination + safe options of the active pane, if it is in an interactive SSH session. */
  const SSH_VALUE_OPTS = new Set(["-p", "-l", "-i", "-J", "-o", "-F", "-E", "-c", "-m", "-b", "-L", "-R", "-D", "-W", "-S", "-O", "-Q", "-w", "-e", "-B", "-I"]);
  function sshTarget(p: Pane | null): string[] | null {
    if (!p) return null;
    const tokens = p.pty.spawn.program === "ssh" ? [...(p.pty.spawn.args ?? [])]
      : (p.pty.blocks.running ?? "").trim().split(/\s+/).filter(Boolean);
    if (p.pty.spawn.program !== "ssh") {
      if (tokens[0] !== "ssh") return null;
      tokens.shift();
    }
    const keep: string[] = [];
    let dest: string | null = null;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (dest) return null; // a remote command follows: not an interactive session
      if (SSH_VALUE_OPTS.has(t)) {
        const v = tokens[++i];
        if (["-p", "-l", "-i", "-J"].includes(t) && v) keep.push(t, v);
      } else if (t.startsWith("-")) continue;
      else dest = t;
    }
    return dest ? [...keep, dest] : null;
  }

  let sysBusy = false;
  let lastRemoteKey = "";
  async function updateSysbar() {
    if (sysBusy || root.hidden || document.hidden) return;
    sysBusy = true;
    const target = sshTarget(activePane());
    const key = target?.join(" ") ?? "";
    try {
      const s = target ? await invoke<Stats>("sys_remote", { args: target }) : await invoke<Stats>("sys_local");
      const mem = s.mem_total ? (100 * s.mem_used) / s.mem_total : 0;
      const disk = s.disk_total ? (100 * s.disk_used) / s.disk_total : 0;
      const loadPct = s.load && s.cores ? (100 * s.load[0]) / s.cores : 0;
      sysbar.innerHTML = `
        <span class="sb-host ${s.remote ? "remote" : ""}" title="${s.remote ? "Удалённая машина (активная SSH-вкладка)" : "Эта машина"}">${s.remote ? "🌐" : "🖥"} ${esc(s.host)}</span>
        ${s.cpu !== null ? `<span class="${lvl(s.cpu)}">CPU <b>${s.cpu.toFixed(0)}%</b><i class="sb-bar"><i style="width:${Math.min(100, s.cpu)}%"></i></i></span>` : `<span class="muted">CPU …</span>`}
        ${s.load ? `<span class="${lvl(loadPct)}" title="load average 1/5/15 мин, ядер: ${s.cores}">load <b>${s.load.map((x) => x.toFixed(2)).join(" ")}</b> <span class="muted">/${s.cores}</span></span>` : ""}
        <span class="${lvl(mem)}">RAM <b>${gb(s.mem_used)}</b> / ${gb(s.mem_total)} <span class="muted">${mem.toFixed(0)}%</span></span>
        ${s.swap_used > 0 ? `<span class="${lvl(s.swap_total ? (100 * s.swap_used) / s.swap_total : 0)}">swap <b>${gb(s.swap_used)}</b></span>` : ""}
        ${s.disk_total ? `<span class="${lvl(disk)}">${esc(s.disk_mount || "/")} <b>${gb(s.disk_used)}</b> / ${gb(s.disk_total)} <span class="muted">${disk.toFixed(0)}%</span></span>` : ""}
        <span class="muted">up ${upt(s.uptime)}</span>`;
      lastRemoteKey = key;
    } catch (e) {
      if (target) {
        sysbar.innerHTML = `<span class="sb-host remote">🌐 ${esc(target[target.length - 1])}</span><span class="muted">${esc(String(e))}</span>`;
        lastRemoteKey = key;
      }
    } finally {
      sysBusy = false;
    }
  }
  setInterval(updateSysbar, 2500);
  window.addEventListener("view-shown", (e) => { if ((e as CustomEvent).detail === "terminal") updateSysbar(); });

  // ----- IDE bridge status -----

  const ideEl = $(".ide-status");
  const setIde = (n: number) => {
    ideEl.textContent = n ? "◆ Claude IDE" : "";
    ideEl.title = n ? "Claude Code подключён к OpsDeck: видит выделение в заметках, @-упоминания" : "";
  };
  listen<number>("ide-status", (e) => setIde(e.payload));
  invoke<{ clients: number }>("ide_status").then((s) => setIde(s.clients)).catch(() => {});

  // ----- wiring -----

  providerSel.onchange = () => { setAiAgent(providerSel.value); startAi(); };
  $("[data-act=new]").onclick = () => newTab();

  // Windows: WSL distributions in one click (the button shows only when WSL has any)
  type WinShell = { id: string; label: string; program: string; args: string[] };
  let wsl: WinShell[] = [];
  if (isWindows()) {
    invoke<WinShell[]>("win_shells").then((list) => {
      wsl = list.filter((x) => x.id.startsWith("wsl:"));
      $("[data-act=wsl]").hidden = !wsl.length;
    }).catch(() => {});
  }
  const openWsl = (sh: WinShell) => newTab({ program: sh.program, args: sh.args, title: sh.id.slice(4) });
  $("[data-act=wsl]").onclick = () => {
    if (wsl.length === 1) return openWsl(wsl[0]);
    document.querySelector(".wsl-menu")?.remove();
    const menu = document.createElement("div");
    menu.className = "web-pick-menu wsl-menu";
    menu.innerHTML = wsl.map((x, i) => `<button class="ghost" data-i="${i}">${esc(x.id.slice(4))}</button>`).join("");
    const r = $("[data-act=wsl]").getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.top = `${r.bottom + 4}px`;
    overlay(true);
    document.body.appendChild(menu);
    const close = (e?: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e && e.type === "pointerdown" && menu.contains(e.target as Node)) return;
      menu.remove();
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", close, true);
      overlay(false);
    };
    menu.addEventListener("click", (e) => {
      const i = (e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i;
      if (i === undefined) return;
      close();
      openWsl(wsl[Number(i)]);
    });
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", close, true);
  };
  $("[data-act=split-r]").onclick = () => split("row");
  $("[data-act=split-d]").onclick = () => split("column");
  $("[data-act=rec]").onclick = toggleRec;
  $("[data-act=records]").onclick = () => { invoke("pty_records_open").catch((e) => toast(String(e), "err")); };
  $("[data-act=font-up]").onclick = () => termFontStep(1);
  $("[data-act=font-down]").onclick = () => termFontStep(-1);
  const fontSizeEl = $(".font-size");
  fontSizeEl.onclick = () => termFontStep(0);
  const syncFont = () => { fontSizeEl.textContent = String(termFontSize()); };
  window.addEventListener("term-font", syncFont);
  syncFont();
  $("[data-act=files]").onclick = () => toggleFiles();
  $("[data-act=ask-ai]").onclick = () => { const p = activePane(); if (p) window.dispatchEvent(new CustomEvent("ai-ask", { detail: p.pty })); };
  $("[data-act=palette]").onclick = () => window.dispatchEvent(new Event("open-palette"));
  $("[data-act=ai]").onclick = () => toggleAi();
  $("[data-act=send]").onclick = sendSelection;
  $("[data-act=ai-restart]").onclick = startAi;
  window.addEventListener("send-to-ai", (e) => sendToAi((e as CustomEvent<string>).detail));
  window.addEventListener("open-terminal", (e) => newTab((e as CustomEvent<OpenTerminalDetail>).detail));

  // ----- Ctrl+Shift+K / ✦ ИИ: local AI turns a request in plain words into a command -----
  const aa = $(".ai-ask"), aaIn = $<HTMLInputElement>(".aa-in"), aaOut = $(".aa-out");
  let aaPty: PtyTerminal | null = null;
  let aaCmd = "";
  const aaClose = () => { aa.hidden = true; aaPty?.term.focus(); };
  async function aaAsk() {
    const request = aaIn.value.trim();
    if (!request || !aaPty) return;
    aaOut.hidden = false;
    $(".aa-cmd").textContent = "думаю… (первый запрос загружает модель, до ~15 с)";
    $(".aa-meta").textContent = "";
    aaCmd = "";
    try {
      const recent = aaPty.blocks.blocks.slice(-10).map((b) => b.command).filter(Boolean);
      const r = await invoke<{ command: string; from_notes: string[]; elapsed_ms: number }>("ai_command", { request, cwd: aaPty.blocks.cwd || null, recent, shell: shellName(aaPty.launched) });
      aaCmd = r.command;
      $(".aa-cmd").textContent = r.command || "(пустой ответ — переформулируйте)";
      $(".aa-meta").textContent = `${(r.elapsed_ms / 1000).toFixed(1)} с${r.from_notes.length ? ` · учтено команд из заметок и истории: ${r.from_notes.length}` : ""}`;
      $<HTMLButtonElement>("[data-aa=paste]").focus();
    } catch (e) {
      const msg = String(e);
      $(".aa-cmd").textContent = msg;
      if (msg.includes("не установлен") || msg.includes("не скачана")) {
        $(".aa-meta").innerHTML = `<button class="ghost" data-aa="setup">Открыть настройки ИИ</button>`;
      }
    }
  }
  window.addEventListener("ai-ask", (e) => {
    aaPty = (e as CustomEvent<PtyTerminal>).detail;
    show();
    aa.hidden = false;
    aaIn.select();
    aaIn.focus();
  });
  aaIn.addEventListener("keydown", (e) => {
    if (e.key === "Escape") aaClose();
    if (e.key === "Enter") { e.preventDefault(); aaAsk(); }
  });
  aa.addEventListener("keydown", (e) => {
    if (e.key === "Escape") aaClose();
    if (e.key === "Enter" && e.ctrlKey && aaCmd) { e.preventDefault(); aaPty?.send(aaCmd + "\r"); aaClose(); }
  });
  aa.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-aa]")?.dataset.aa;
    if (a === "close") aaClose();
    if (a === "again") aaAsk();
    if (a === "setup") { aaClose(); window.dispatchEvent(new CustomEvent("show-view", { detail: "settings" })); }
    if ((a === "paste" || a === "run") && aaCmd && aaPty) {
      // paste goes through bracketed paste: nothing runs until Enter
      if (a === "paste") aaPty.term.paste(aaCmd); else aaPty.send(aaCmd + "\r");
      aaClose();
    }
  });

  window.addEventListener("keydown", (e) => {
    if (root.hidden || !e.ctrlKey || !e.shiftKey) return;
    // letters by key position, so the shortcuts also work on the Russian layout
    const k = e.code.startsWith("Key") ? e.code.slice(3) : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    const p = activePane();
    if (k === "T") newTab();
    else if (k === "W" && p) closePane(p);
    else if (k === "R" && p) retry(p);
    else if (k === "D") split("row");
    else if (k === "E") split("column");
    else if (k === "I") toggleAi();
    else if (k === "B") toggleFiles();
    else if (k === "A") sendSelection();
    else if (k === "K" && p) window.dispatchEvent(new CustomEvent("ai-ask", { detail: p.pty }));
    else if (k === "ArrowUp" && p) p.pty.blocks.jump(-1);
    else if (k === "ArrowDown" && p) p.pty.blocks.jump(1);
    else if (k === "ArrowRight") cyclePane(1);
    else if (k === "ArrowLeft") cyclePane(-1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // tab switching (#26): Alt+1…9 (9 = last), Alt+←/→, Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+PageDown/PageUp
  const cycleTab = (step: number) => {
    if (tabs.length < 2 || !activeTab) return;
    activate(tabs[(tabs.indexOf(activeTab) + step + tabs.length) % tabs.length]);
  };
  window.addEventListener("keydown", (e) => {
    if (root.hidden || e.metaKey) return;
    const alt = e.altKey && !e.ctrlKey && !e.shiftKey;
    const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
    if (alt && digit) {
      const n = Number(digit);
      const t = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
      if (!t) return;
      activate(t);
    } else if (alt && (e.key === "ArrowRight" || e.key === "ArrowLeft")) cycleTab(e.key === "ArrowRight" ? 1 : -1);
    else if (e.ctrlKey && !e.altKey && e.key === "Tab") cycleTab(e.shiftKey ? -1 : 1);
    else if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === "PageDown" || e.key === "PageUp")) cycleTab(e.key === "PageDown" ? 1 : -1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  window.addEventListener("view-shown", (e) => {
    if ((e as CustomEvent).detail !== "terminal") return;
    requestAnimationFrame(() => {
      activeTab?.panes.forEach((p) => p.pty.resize());
      ai?.resize();
      // the local AI box opens together with the view: keep the cursor in its input
      if (root.querySelector(".ai-ask")?.hasAttribute("hidden") !== false) activePane()?.pty.term.focus();
    });
  });

  registerProvider(() => [
    { group: "Терминал", title: "Новая вкладка", hint: "Ctrl+Shift+T", run: () => { show(); newTab(); } },
    { group: "Терминал", title: "Следующая вкладка", hint: "Alt+→ · Ctrl+Tab", run: () => { show(); cycleTab(1); } },
    { group: "Терминал", title: "Предыдущая вкладка", hint: "Alt+← · Ctrl+Shift+Tab", run: () => { show(); cycleTab(-1); } },
    { group: "Терминал", title: "Разделить вправо", hint: "Ctrl+Shift+D", run: () => { show(); split("row"); } },
    { group: "Терминал", title: "Разделить вниз", hint: "Ctrl+Shift+E", run: () => { show(); split("column"); } },
    { group: "Терминал", title: "AI-панель: показать/скрыть", hint: "Ctrl+Shift+I", run: () => { show(); toggleAi(); } },
    { group: "Терминал", title: "Файлы: показать/скрыть", hint: "Ctrl+Shift+B", run: () => { show(); toggleFiles(); } },
    { group: "Терминал", title: "Запись сессии: вкл/выкл", hint: "⏺", run: () => { show(); toggleRec(); } },
    { group: "Терминал", title: `Подсветка ввода: ${hlPrefs().input ? "выключить" : "включить"}`, hint: "цвета команды при наборе", run: () => setHlPrefs({ input: !hlPrefs().input }) },
    { group: "Терминал", title: `Подсветка вывода: ${hlPrefs().output ? "выключить" : "включить"}`, hint: "ERROR/WARN, статусы, IP, ссылки", run: () => setHlPrefs({ output: !hlPrefs().output }) },
    { group: "Терминал", title: "Шрифт крупнее", hint: "Ctrl+=", run: () => termFontStep(1) },
    { group: "Терминал", title: "Шрифт мельче", hint: "Ctrl+-", run: () => termFontStep(-1) },
    { group: "Терминал", title: "Шрифт по умолчанию", hint: "Ctrl+0", run: () => termFontStep(0) },
    { group: "Терминал", title: "Открыть папку с записями сессий", run: () => { invoke("pty_records_open").catch((e) => toast(String(e), "err")); } },
    ...Object.keys(AI_PROVIDERS).map((name) => ({
      group: "AI", title: `AI-панель: ${name}`, run: () => { show(); providerSel.value = name; setAiAgent(name); startAi(); toggleAi(true); },
    })),
    // recent commands of the active pane, newest first, without duplicates
    ...[...new Map(terminalApi.history().map((b) => [b.command, b])).values()].slice(0, 40).map((b) => ({
      group: "История", title: b.command, hint: b.exit === 0 ? "✓" : `✗ ${b.exit}`,
      run: () => terminalApi.paste(b.command),
    })),
  ]);
  const show = () => window.dispatchEvent(new CustomEvent("show-view", { detail: "terminal" }));

  newTab();
  if (load("opsdeck.files.open", "0") === "1") toggleFiles(true);
}
