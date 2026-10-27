import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { mountTerminal } from "./modules/terminal";
import { mountNetwork } from "./modules/network";
import { mountConnectors } from "./modules/connectors";
import { mountK8s } from "./modules/k8s";
import { mountKeepass } from "./modules/keepass";
import { mountPassbolt } from "./modules/passbolt";
import { mountNotes } from "./modules/notes";
import { mountDb } from "./modules/db";
import { mountTasks } from "./modules/tasks";
import { mountMikrotik } from "./modules/mikrotik";
import { mountMonitor } from "./modules/monitor";
import { mountSettings } from "./modules/settings";
import { mountAiAgent } from "./modules/aiagent";
import { mountSftp } from "./modules/sftp";
import { mountYc } from "./modules/yc";
import { mountSsh } from "./modules/ssh";
import { mountAlerts } from "./modules/alerts";
import { checkUpdates } from "./modules/updates";
import { esc, logUi, overlay, toast } from "./modules/ui";
import { currentLang, startI18n, t } from "./i18n";
import { popoutOpen, popoutViews, routeToMain, type Route } from "./modules/popout";
import { popoutView, winLabel } from "./modules/winid";
import { watchJs } from "./modules/jswatch";

// стояла ли сама страница во время зависания окна (строка рядом с «UI FREEZE» в журнале)
watchJs((m) => logUi("warn", m));

// anything that blows up in the UI ends up in the log file (⚙ → Журнал)
window.addEventListener("error", (e) => logUi("error", `JS: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}${e.error?.stack ? "\n" + e.error.stack : ""}`));
window.addEventListener("unhandledrejection", (e) => logUi("error", `Promise: ${e.reason?.stack ?? e.reason}`));
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { registerProvider } from "./modules/palette";

import { icon } from "./modules/icons";

// lazy: the module is a separate chunk, imported and mounted on the first open rather than at startup
type View = { id: string; svg: string; title: string; mount: (el: HTMLElement) => void | Promise<void>; bottom?: boolean; lazy?: boolean };

const views: View[] = [
  { id: "terminal", svg: icon("terminal", 20), title: "Терминал + AI", mount: mountTerminal },
  { id: "k8s", svg: icon("k8s", 20), title: "Kubernetes", mount: mountK8s },
  { id: "web", svg: icon("web", 20), title: "Grafana · ArgoCD · GitLab", mount: mountConnectors },
  { id: "alerts", svg: icon("bell", 20), title: "Алерты", mount: mountAlerts },
  { id: "net", svg: icon("net", 20), title: "Сеть и DNS", mount: mountNetwork },
  { id: "ssh", svg: icon("server", 20), title: "SSH", mount: mountSsh },
  { id: "monitor", svg: icon("activity", 20), title: "Мониторинг хостов", mount: mountMonitor },
  { id: "sftp", svg: icon("folderOpen", 20), title: "Файлы на хостах", mount: mountSftp },
  { id: "yc", svg: icon("cloud", 20), title: "Yandex Cloud", mount: mountYc },
  // CodeMirror and yaml are about half of all the code, and only the IDE needs them
  { id: "code", svg: icon("code", 20), title: "IDE: код и git", mount: (el) => import("./modules/code").then((m) => m.mountCode(el)), lazy: true },
  { id: "db", svg: icon("db", 20), title: "Базы данных", mount: mountDb },
  { id: "notes", svg: icon("notes", 20), title: "Заметки", mount: mountNotes },
  { id: "tasks", svg: icon("tasks", 20), title: "Задачи и напоминания", mount: mountTasks },
  { id: "vault", svg: icon("key", 20), title: "KeePass", mount: mountKeepass },
  { id: "passbolt", svg: icon("lock", 20), title: "Passbolt", mount: mountPassbolt },
  { id: "winbox", svg: icon("router", 20), title: "MikroTik / WinBox", mount: mountMikrotik },
  { id: "agent", svg: icon("sparkles", 20), title: "ИИ-агент", mount: mountAiAgent },
  { id: "settings", svg: icon("settings", 20), title: "Настройки", mount: mountSettings, bottom: true },
];

/** Это окно открыто на одном разделе (метка окна `pop-<раздел>`): боковой колонки в нём нет. */
const POP = popoutView();

startI18n();
// the backend translates its own notifications (reminders, alerts) the same way
invoke("set_lang", { lang: currentLang() }).catch(() => {});

if (POP) document.body.classList.add("popout");

const sidebar = document.getElementById("sidebar")!;
const container = document.getElementById("views")!;
const panes = new Map<string, HTMLElement>();
// views whose module is mounted (a lazy one: also loaded) and listens to its events
const ready = new Set<string>();
// a lazy view still loading: resolves true when mounted, false if its chunk failed to load
const loading = new Map<string, Promise<boolean>>();

// ----- modules: which views are on (⊞ menu in the sidebar); off ones are not even mounted -----
const MODULES_KEY = "opsdeck.modules";
const DEFAULT_MODULES = ["terminal", "k8s", "ssh", "vault", "notes"];
const optional = views.filter((v) => !v.bottom);
const enabled = new Set<string>(((): string[] => {
  // вынесенное окно показывает ровно один раздел и не трогает набор модулей главного окна
  if (POP) return [POP];
  try {
    const saved = localStorage.getItem(MODULES_KEY);
    if (saved) return JSON.parse(saved);
    // an existing install keeps everything it had; a fresh one starts with the basic set
    const used = Object.keys(localStorage).some((k) => k.startsWith("opsdeck.") && k !== "opsdeck.lang");
    return used ? optional.map((v) => v.id) : DEFAULT_MODULES;
  } catch { return DEFAULT_MODULES; }
})());
const saveModules = () => {
  if (POP) return;
  try { localStorage.setItem(MODULES_KEY, JSON.stringify([...enabled])); } catch { /* ignore */ }
};
saveModules();
// в вынесенном окне ⚙ Настройки тоже не монтируются: один раздел — один модуль
const isOn = (id: string) => enabled.has(id) || (!POP && !!views.find((v) => v.id === id)?.bottom);
const firstOn = () => movable().find((b) => !b.hidden)?.dataset.view ?? "settings";

/** Mount a view on first use. */
function ensure(id: string): Promise<boolean> {
  if (ready.has(id)) return Promise.resolve(true);
  const pending = loading.get(id);
  if (pending) return pending;
  if (panes.has(id)) return Promise.resolve(false); // its chunk failed to load: the pane says so
  const v = views.find((x) => x.id === id);
  if (!v) return Promise.resolve(false);
  const pane = document.createElement("section");
  pane.className = "view";
  pane.hidden = true;
  container.appendChild(pane);
  panes.set(id, pane);
  const r = v.mount(pane);
  if (!(r instanceof Promise)) {
    ready.add(id);
    return Promise.resolve(true);
  }
  pane.innerHTML = `<p class="muted pad view-loading">загрузка…</p>`;
  const done = r.then(() => {
    ready.add(id);
    // show() announced the view before its module was there to hear it
    if (!pane.hidden) window.dispatchEvent(new CustomEvent("view-shown", { detail: id }));
    return true;
  }, (err) => {
    logUi("error", `view ${id}: ${err?.stack ?? err}`);
    pane.innerHTML = `<p class="pad err">${esc(`Не удалось загрузить раздел «${v.title}»: ${err}`)}</p>`;
    return false;
  }).finally(() => loading.delete(id));
  loading.set(id, done);
  return done;
}
const mountAtStart = (id: string) => !views.find((v) => v.id === id)?.lazy;

function setModule(id: string, on: boolean) {
  if (on) enabled.add(id); else enabled.delete(id);
  saveModules();
  const btn = sidebar.querySelector<HTMLElement>(`button[data-view="${id}"]`);
  if (btn) btn.hidden = !on;
  if (on) { if (mountAtStart(id)) ensure(id); }
  else if (panes.get(id)?.hidden === false) show(firstOn());
}

function show(id: string) {
  // в вынесенном окне другого раздела нет: просим главное окно показать его и поднимаем это окно
  if (POP && id !== POP) return routeToMain(id);
  if (!isOn(id)) {
    // another module needs it (e.g. SSH opens a terminal tab): switch it on
    setModule(id, true);
    toast(`Модуль «${views.find((v) => v.id === id)?.title ?? id}» включён`);
  }
  ensure(id);
  for (const [vid, el] of panes) el.hidden = vid !== id;
  sidebar.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.view === id));
  window.dispatchEvent(new CustomEvent("view-shown", { detail: id }));
}

for (const v of views) {
  const btn = document.createElement("button");
  btn.dataset.view = v.id;
  btn.title = v.title;
  btn.innerHTML = v.svg;
  btn.onclick = () => show(v.id);
  btn.hidden = !isOn(v.id);
  if (v.bottom) {
    const mods = document.createElement("button");
    mods.className = "bottom modules-btn";
    mods.title = "Модули";
    mods.innerHTML = icon("grid", 20);
    mods.onclick = (e) => { e.stopPropagation(); toggleModulesMenu(mods); };
    sidebar.appendChild(mods);
    btn.classList.add("bottom");
  }
  sidebar.appendChild(btn);
  if (isOn(v.id) && mountAtStart(v.id)) ensure(v.id);
}

// правый клик по иконке модуля: вынести его в отдельное окно
let closeViewMenu: (() => void) | null = null;
sidebar.addEventListener("contextmenu", async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-view]");
  const id = btn?.dataset.view;
  if (!id) return;
  e.preventDefault(); // до await: после него системное меню уже успело бы открыться
  if (!(await popoutViews()).has(id)) return;
  closeViewMenu?.();
  const pop = document.createElement("div");
  pop.className = "modules-pop view-menu";
  pop.innerHTML = `<button class="menu-item" data-pop="${id}">${icon("externalLink", 16)}<span>${esc(t("Вынести в отдельное окно"))}</span></button>`;
  const r = btn!.getBoundingClientRect();
  pop.style.left = `${r.right + 8}px`;
  pop.style.top = `${Math.min(r.top, window.innerHeight - 60)}px`;
  overlay(true);
  document.body.appendChild(pop);
  const done = () => {
    pop.remove();
    document.removeEventListener("pointerdown", close, true);
    document.removeEventListener("keydown", close, true);
    closeViewMenu = null;
    overlay(false);
  };
  const close = (ev: Event) => {
    if (ev instanceof KeyboardEvent ? ev.key !== "Escape" : pop.contains(ev.target as Node)) return;
    done();
  };
  closeViewMenu = done;
  pop.querySelector("[data-pop]")!.addEventListener("click", () => { popoutOpen(id); done(); });
  document.addEventListener("pointerdown", close, true);
  document.addEventListener("keydown", close, true);
});

let closeModulesMenu: (() => void) | null = null;
function toggleModulesMenu(anchor: HTMLElement) {
  if (closeModulesMenu) return closeModulesMenu();
  const pop = document.createElement("div");
  pop.className = "modules-pop";
  pop.innerHTML = `<div class="modules-head">Модули</div>` +
    optional.map((v) => `<label class="check"><input type="checkbox" data-mod="${v.id}" ${enabled.has(v.id) ? "checked" : ""} />${v.svg}<span>${esc(v.title)}</span></label>`).join("") +
    `<p class="muted hint">Выключенный модуль пропадает из меню и не загружается при следующем запуске.</p>`;
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${r.right + 8}px`;
  pop.style.bottom = `${Math.max(8, window.innerHeight - r.bottom)}px`;
  // an open web panel is a native view over the window: it hides while the menu is open
  overlay(true);
  document.body.appendChild(pop);
  pop.addEventListener("change", (e) => {
    const box = (e.target as HTMLElement).closest<HTMLInputElement>("input[data-mod]");
    if (box) setModule(box.dataset.mod!, box.checked);
  });
  const done = () => {
    pop.remove();
    document.removeEventListener("pointerdown", close, true);
    document.removeEventListener("keydown", close, true);
    closeModulesMenu = null;
    overlay(false);
  };
  const close = (e: Event) => {
    if (e instanceof KeyboardEvent ? e.key !== "Escape" : pop.contains(e.target as Node) || anchor.contains(e.target as Node)) return;
    done();
  };
  closeModulesMenu = done;
  document.addEventListener("pointerdown", close, true);
  document.addEventListener("keydown", close, true);
}

// events handled inside a module: if it was never mounted, mount it and deliver the event again
const ROUTED: Record<string, string> = {
  "open-terminal": "terminal", "send-to-ai": "terminal", "ai-ask": "terminal",
  "open-in-code": "code", "open-note": "notes", "add-connector": "web", "open-url": "web",
};
for (const [type, id] of Object.entries(ROUTED)) {
  if (POP && id === POP) continue; // этот раздел здесь и есть, он обработает событие сам
  window.addEventListener(type, (e) => {
    if (ready.has(id)) return;
    e.stopImmediatePropagation();
    const detail = (e as CustomEvent).detail;
    // из вынесенного окна событие уезжает в главное вместе с разделом, который его ждёт
    if (POP) return routeToMain(id, type, detail);
    show(id);
    // a lazy module may still be loading: deliver once it listens
    ensure(id).then((ok) => { if (ok) window.dispatchEvent(new CustomEvent(type, { detail })); });
  }, true);
}

// главное окно: вынесенное попросило показать раздел (и, если дело было в событии, повторить его)
if (!POP) {
  listen<Route>("popout-route", (e) => {
    const { view, type, detail } = e.payload;
    if (!views.some((v) => v.id === view)) return;
    show(view);
    if (type && type in ROUTED) queueMicrotask(() => window.dispatchEvent(new CustomEvent(type, { detail })));
  });
}

// ----- user order of the sidebar icons: drag with the mouse, kept in localStorage -----
const ORDER_KEY = "opsdeck.sidebar.order";
function movable() { return [...sidebar.querySelectorAll<HTMLButtonElement>("button[data-view]:not(.bottom)")]; }
const bottomBtn = sidebar.querySelector("button.bottom");
try {
  const saved: string[] = JSON.parse(localStorage.getItem(ORDER_KEY) || "[]");
  const byId = new Map(movable().map((b) => [b.dataset.view!, b]));
  // saved ones first in their order; views added in later versions keep their default place after them
  for (const id of saved) { const b = byId.get(id); if (b) sidebar.insertBefore(b, bottomBtn); }
  for (const b of movable()) if (!saved.includes(b.dataset.view!)) sidebar.insertBefore(b, bottomBtn);
} catch { /* broken value: default order */ }

// pointer-based (HTML5 drag-and-drop is unreliable inside the Tauri webview)
let dragJustEnded = false;
sidebar.addEventListener("pointerdown", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-view]:not(.bottom)");
  if (!btn || e.button !== 0) return;
  const startY = e.clientY;
  let dragging = false;
  const move = (ev: PointerEvent) => {
    if (!dragging) {
      if (Math.abs(ev.clientY - startY) < 6) return;
      dragging = true;
      btn.setPointerCapture(ev.pointerId);
      btn.classList.add("dragging");
    }
    const others = movable().filter((b) => b !== btn);
    const before = others.find((b) => { const r = b.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
    sidebar.insertBefore(btn, before ?? bottomBtn);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (!dragging) return;
    btn.classList.remove("dragging");
    dragJustEnded = true;
    setTimeout(() => { dragJustEnded = false; }, 0);
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(movable().map((b) => b.dataset.view))); } catch { /* ignore */ }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
});
// the click that ends a drag must not switch the view
sidebar.addEventListener("click", (e) => { if (dragJustEnded) { e.stopPropagation(); e.preventDefault(); } }, true);

// a module asked for a terminal tab: switch to the terminal view (the tab itself is created there)
window.addEventListener("open-terminal", () => show("terminal"));
// другое окно отдаёт нам вкладку: раздел должен быть смонтирован, иначе сессию некому принять
listen<string>("term-handoff", (e) => { if (e.payload === winLabel() && !panes.has("terminal")) show("terminal"); });
window.addEventListener("show-view", (e) => show((e as CustomEvent<string>).detail));
// firing-alerts counter on the 🔔 button
const setAlertBadge = (n: number) => {
  const b = sidebar.querySelector<HTMLElement>("[data-view=alerts]");
  if (!b) return;
  b.dataset.badge = n > 99 ? "99+" : String(n);
  b.classList.toggle("has-badge", n > 0);
};
if (!POP) {
  listen<number>("alerts-changed", (e) => setAlertBadge(e.payload));
  invoke<{ firing: number }>("alerts_get", { historyLimit: 0 }).then((v) => setAlertBadge(v.firing)).catch(() => {});

  // quiet update check a little after startup (if enabled in settings): дело главного окна
  setTimeout(() => {
    invoke<{ update_auto_check: boolean }>("settings_get")
      .then((s) => { if (s.update_auto_check) checkUpdates(true); })
      .catch(() => {});
  }, 8000);
}

// Ctrl+Shift+1…9 — модуль по его месту в колонке слева (9 — последний): на ноутбуке без мыши
// переключаться быстрее, чем тыкать иконки (#79). Alt+цифры заняты вкладками терминала.
document.addEventListener("keydown", (e) => {
  if (POP || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
  const n = Number(e.code.startsWith("Digit") ? e.code.slice(5) : "");
  if (!n || n < 1 || n > 9) return;
  const on = movable().filter((b) => !b.hidden);
  const btn = n === 9 ? on.at(-1) : on[n - 1];
  if (!btn?.dataset.view) return;
  e.preventDefault();
  show(btn.dataset.view);
  // capture: иначе в терминале сочетание до нас не доходит — xterm останавливает событие
}, true);

registerProvider(() => views.filter((v) => isOn(v.id)).map((v) => ({ group: "Перейти", title: v.title, hint: v.id, run: () => show(v.id) })));
window.addEventListener("send-to-ai", () => show("terminal"));

if (POP) {
  // из вынесенного окна возвращаемся в главное — там боковая колонка и все остальные разделы
  registerProvider(() => [{ group: "Окно", title: "Вернуться в главное окно", hint: "", run: () => routeToMain(POP) }]);
  show(POP);
} else {
  // группа и название — отдельные строки интерфейса: так их переводит тот же словарь
  popoutViews().then((can) => registerProvider(() => views.filter((v) => isOn(v.id) && can.has(v.id))
    .map((v) => ({ group: "Вынести в отдельное окно", title: v.title, hint: v.id, run: () => popoutOpen(v.id) }))));
  show(isOn("terminal") ? "terminal" : firstOn());
}
