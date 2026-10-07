import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { mountTerminal } from "./modules/terminal";
import { mountNetwork } from "./modules/network";
import { mountConnectors } from "./modules/connectors";
import { mountK8s } from "./modules/k8s";
import { mountKeepass } from "./modules/keepass";
import { mountNotes } from "./modules/notes";
import { mountDb } from "./modules/db";
import { mountCode } from "./modules/code";
import { mountTasks } from "./modules/tasks";
import { mountMikrotik } from "./modules/mikrotik";
import { mountMonitor } from "./modules/monitor";
import { mountSettings } from "./modules/settings";
import { mountSsh } from "./modules/ssh";
import { mountAlerts } from "./modules/alerts";
import { checkUpdates } from "./modules/updates";
import { esc, logUi, toast } from "./modules/ui";
import { currentLang, startI18n } from "./i18n";

// anything that blows up in the UI ends up in the log file (⚙ → Журнал)
window.addEventListener("error", (e) => logUi("error", `JS: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}${e.error?.stack ? "\n" + e.error.stack : ""}`));
window.addEventListener("unhandledrejection", (e) => logUi("error", `Promise: ${e.reason?.stack ?? e.reason}`));
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { registerProvider } from "./modules/palette";

import { icon } from "./modules/icons";

type View = { id: string; svg: string; title: string; mount: (el: HTMLElement) => void; bottom?: boolean };

const views: View[] = [
  { id: "terminal", svg: icon("terminal", 20), title: "Терминал + AI", mount: mountTerminal },
  { id: "k8s", svg: icon("k8s", 20), title: "Kubernetes", mount: mountK8s },
  { id: "web", svg: icon("web", 20), title: "Grafana · ArgoCD · GitLab", mount: mountConnectors },
  { id: "alerts", svg: icon("bell", 20), title: "Алерты", mount: mountAlerts },
  { id: "net", svg: icon("net", 20), title: "Сеть и DNS", mount: mountNetwork },
  { id: "ssh", svg: icon("server", 20), title: "SSH", mount: mountSsh },
  { id: "monitor", svg: icon("activity", 20), title: "Мониторинг хостов", mount: mountMonitor },
  { id: "code", svg: icon("code", 20), title: "IDE: код и git", mount: mountCode },
  { id: "db", svg: icon("db", 20), title: "Базы данных", mount: mountDb },
  { id: "notes", svg: icon("notes", 20), title: "Заметки", mount: mountNotes },
  { id: "tasks", svg: icon("tasks", 20), title: "Задачи и напоминания", mount: mountTasks },
  { id: "vault", svg: icon("key", 20), title: "KeePass", mount: mountKeepass },
  { id: "winbox", svg: icon("router", 20), title: "MikroTik / WinBox", mount: mountMikrotik },
  { id: "settings", svg: icon("settings", 20), title: "Настройки", mount: mountSettings, bottom: true },
];

startI18n();
// the backend translates its own notifications (reminders, alerts) the same way
invoke("set_lang", { lang: currentLang() }).catch(() => {});

const sidebar = document.getElementById("sidebar")!;
const container = document.getElementById("views")!;
const panes = new Map<string, HTMLElement>();

// ----- modules: which views are on (⊞ menu in the sidebar); off ones are not even mounted -----
const MODULES_KEY = "opsdeck.modules";
const DEFAULT_MODULES = ["terminal", "k8s", "ssh", "vault", "notes"];
const optional = views.filter((v) => !v.bottom);
const enabled = new Set<string>(((): string[] => {
  try {
    const saved = localStorage.getItem(MODULES_KEY);
    if (saved) return JSON.parse(saved);
    // an existing install keeps everything it had; a fresh one starts with the basic set
    const used = Object.keys(localStorage).some((k) => k.startsWith("opsdeck.") && k !== "opsdeck.lang");
    return used ? optional.map((v) => v.id) : DEFAULT_MODULES;
  } catch { return DEFAULT_MODULES; }
})());
const saveModules = () => { try { localStorage.setItem(MODULES_KEY, JSON.stringify([...enabled])); } catch { /* ignore */ } };
saveModules();
const isOn = (id: string) => enabled.has(id) || !!views.find((v) => v.id === id)?.bottom;
const firstOn = () => movable().find((b) => !b.hidden)?.dataset.view ?? "settings";

/** Mount a view on first use. */
function ensure(id: string) {
  if (panes.has(id)) return;
  const v = views.find((x) => x.id === id);
  if (!v) return;
  const pane = document.createElement("section");
  pane.className = "view";
  pane.hidden = true;
  container.appendChild(pane);
  panes.set(id, pane);
  v.mount(pane);
}

function setModule(id: string, on: boolean) {
  if (on) enabled.add(id); else enabled.delete(id);
  saveModules();
  const btn = sidebar.querySelector<HTMLElement>(`button[data-view="${id}"]`);
  if (btn) btn.hidden = !on;
  if (on) ensure(id);
  else if (panes.get(id)?.hidden === false) show(firstOn());
}

function show(id: string) {
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
  if (isOn(v.id)) ensure(v.id);
}

function toggleModulesMenu(anchor: HTMLElement) {
  const old = document.querySelector(".modules-pop");
  if (old) return old.remove();
  const pop = document.createElement("div");
  pop.className = "modules-pop";
  pop.innerHTML = `<div class="modules-head">Модули</div>` +
    optional.map((v) => `<label class="check"><input type="checkbox" data-mod="${v.id}" ${enabled.has(v.id) ? "checked" : ""} />${v.svg}<span>${esc(v.title)}</span></label>`).join("") +
    `<p class="muted hint">Выключенный модуль пропадает из меню и не загружается при следующем запуске.</p>`;
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${r.right + 8}px`;
  pop.style.bottom = `${Math.max(8, window.innerHeight - r.bottom)}px`;
  document.body.appendChild(pop);
  pop.addEventListener("change", (e) => {
    const box = (e.target as HTMLElement).closest<HTMLInputElement>("input[data-mod]");
    if (box) setModule(box.dataset.mod!, box.checked);
  });
  const close = (e: Event) => {
    if (e instanceof KeyboardEvent ? e.key !== "Escape" : pop.contains(e.target as Node) || anchor.contains(e.target as Node)) return;
    pop.remove();
    document.removeEventListener("pointerdown", close, true);
    document.removeEventListener("keydown", close, true);
  };
  document.addEventListener("pointerdown", close, true);
  document.addEventListener("keydown", close, true);
}

// events handled inside a module: if it was never mounted, mount it and deliver the event again
const ROUTED: Record<string, string> = {
  "open-terminal": "terminal", "send-to-ai": "terminal", "ai-ask": "terminal",
  "open-in-code": "code", "open-note": "notes", "add-connector": "web", "open-url": "web",
};
for (const [type, id] of Object.entries(ROUTED)) {
  window.addEventListener(type, (e) => {
    if (panes.has(id)) return;
    e.stopImmediatePropagation();
    show(id);
    const detail = (e as CustomEvent).detail;
    queueMicrotask(() => window.dispatchEvent(new CustomEvent(type, { detail })));
  }, true);
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
window.addEventListener("show-view", (e) => show((e as CustomEvent<string>).detail));
// firing-alerts counter on the 🔔 button
const setAlertBadge = (n: number) => {
  const b = sidebar.querySelector<HTMLElement>("[data-view=alerts]");
  if (!b) return;
  b.dataset.badge = n > 99 ? "99+" : String(n);
  b.classList.toggle("has-badge", n > 0);
};
listen<number>("alerts-changed", (e) => setAlertBadge(e.payload));
invoke<{ firing: number }>("alerts_get", { historyLimit: 0 }).then((v) => setAlertBadge(v.firing)).catch(() => {});

// quiet update check a little after startup (if enabled in settings)
setTimeout(() => {
  invoke<{ update_auto_check: boolean }>("settings_get")
    .then((s) => { if (s.update_auto_check) checkUpdates(true); })
    .catch(() => {});
}, 8000);

registerProvider(() => views.filter((v) => isOn(v.id)).map((v) => ({ group: "Перейти", title: v.title, hint: v.id, run: () => show(v.id) })));
window.addEventListener("send-to-ai", () => show("terminal"));

show(isOn("terminal") ? "terminal" : firstOn());
