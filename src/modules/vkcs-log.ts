import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { currentLang, t } from "../i18n";
import { icon } from "./icons";
import { copyText, toast } from "./ui";

type Entry = {
  id: number; revision: number; timestamp: string; command: string;
  phase: "running" | "success" | "error" | "timeout"; exit_code: number | null;
  transport?: "cli" | "sdk";
};
const LIMIT = 500;
const HEIGHT_KEY = "opsdeck.vkcs.logHeight";

export async function mountVkcsLog(root: HTMLElement) {
  root.innerHTML = `
    <div class="vkcs-log-split" role="separator" tabindex="0" aria-orientation="horizontal"
      aria-label="Высота панели лога" aria-controls="vkcs-command-log" hidden></div>
    <section class="vkcs-log-panel" id="vkcs-command-log" aria-label="Лог команд VK Cloud" hidden>
      <div class="vkcs-log-entries"><p class="muted pad vkcs-log-empty">Команды пока не запускались</p></div>
    </section>
    <div class="vkcs-statusbar">
      <span class="vkcs-log-status" role="status">Готово</span>
      <span class="vkcs-log-count muted"></span>
      <button class="ghost vkcs-log-toggle" aria-expanded="false" aria-controls="vkcs-command-log">Показать лог</button>
    </div>`;
  const panel = root.querySelector<HTMLElement>(".vkcs-log-panel")!;
  const handle = root.querySelector<HTMLElement>(".vkcs-log-split")!;
  const entriesEl = root.querySelector<HTMLElement>(".vkcs-log-entries")!;
  const toggle = root.querySelector<HTMLButtonElement>(".vkcs-log-toggle")!;
  const status = root.querySelector<HTMLElement>(".vkcs-log-status")!;
  const count = root.querySelector<HTMLElement>(".vkcs-log-count")!;
  const page = root.closest<HTMLElement>(".vkcs")!;
  const body = page.querySelector<HTMLElement>(".vkcs-body")!;
  const entries = new Map<number, Entry>();
  const rows = new Map<number, HTMLElement>();
  const dateFormat = new Intl.DateTimeFormat(currentLang() === "ru" ? "ru-RU" : "en-GB", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  let height = 200;
  try { const saved = Number(localStorage.getItem(HEIGHT_KEY)); if (Number.isFinite(saved) && saved > 0) height = saved; } catch { /* optional preference */ }

  const maxHeight = () => Math.max(80, Math.min(page.clientHeight * 0.7, panel.offsetHeight + body.clientHeight - 100));
  function setHeight(value: number, save = false) {
    height = Math.max(80, Math.min(maxHeight(), value));
    panel.style.height = `${height}px`;
    handle.setAttribute("aria-valuemin", "80");
    handle.setAttribute("aria-valuemax", String(Math.round(maxHeight())));
    handle.setAttribute("aria-valuenow", String(Math.round(height)));
    if (save) try { localStorage.setItem(HEIGHT_KEY, String(height)); } catch { /* optional preference */ }
  }
  toggle.onclick = () => {
    const open = panel.hidden;
    panel.hidden = handle.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = t(open ? "Скрыть лог" : "Показать лог");
    if (open) { setHeight(height); entriesEl.scrollTop = entriesEl.scrollHeight; }
  };
  let drag: { pointer: number; y: number; height: number } | null = null;
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { pointer: e.pointerId, y: e.clientY, height: panel.offsetHeight };
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("drag");
  });
  handle.addEventListener("pointermove", (e) => {
    if (drag?.pointer === e.pointerId) setHeight(drag.height + drag.y - e.clientY);
  });
  const finishDrag = () => {
    if (!drag) return;
    drag = null;
    handle.classList.remove("drag");
    setHeight(height, true);
  };
  handle.addEventListener("pointerup", finishDrag);
  handle.addEventListener("pointercancel", finishDrag);
  handle.addEventListener("lostpointercapture", finishDrag);
  handle.addEventListener("keydown", (e) => {
    const next = { ArrowUp: height + 24, ArrowDown: height - 24, Home: 80, End: maxHeight() }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setHeight(next, true);
  });
  handle.addEventListener("dblclick", () => setHeight(200, true));
  const observer = new ResizeObserver(() => { if (!panel.hidden && page.clientHeight > 0) setHeight(height); });
  observer.observe(page);

  function merge(entry: Entry) {
    if ((entries.get(entry.id)?.revision ?? -1) >= entry.revision) return;
    const atBottom = entriesEl.scrollTop + entriesEl.clientHeight >= entriesEl.scrollHeight - 24;
    entries.set(entry.id, entry);
    let row = rows.get(entry.id);
    if (!row) {
      entriesEl.querySelector(".vkcs-log-empty")?.remove();
      row = document.createElement("div");
      row.className = "vkcs-log-row";
      row.innerHTML = `<time data-no-i18n></time><span class="vkcs-log-phase"></span><code></code><button class="icon" title="Копировать команду">${icon("copy", 14)}</button>`;
      const time = row.querySelector("time")!;
      time.dateTime = entry.timestamp;
      const date = new Date(entry.timestamp);
      time.textContent = Number.isNaN(date.getTime()) ? entry.timestamp : dateFormat.format(date);
      row.querySelector("code")!.textContent = entry.command;
      row.dataset.transport = entry.transport ?? "cli";
      const transport = document.createElement("span");
      transport.className = "muted";
      transport.textContent = entry.transport === "sdk" ? "SDK" : "CLI";
      transport.title = entry.transport === "sdk" ? "OpenStack SDK · CLI equivalent" : "OpenStack CLI process";
      row.insertBefore(transport, row.querySelector("code"));
      row.querySelector("button")!.onclick = async () => {
        try { await copyText(entry.command); toast("Команда скопирована"); }
        catch (e) { toast(String(e), "err"); }
      };
      const nextId = [...rows.keys()].sort((a, b) => a - b).find((id) => id > entry.id);
      entriesEl.insertBefore(row, nextId === undefined ? null : rows.get(nextId)!);
      rows.set(entry.id, row);
    }
    row.dataset.phase = entry.phase;
    const phase = row.querySelector<HTMLElement>(".vkcs-log-phase")!;
    phase.textContent = { running: "…", success: "✓", error: "✕", timeout: "⌛" }[entry.phase];
    phase.title = entry.phase === "running" ? t("Выполняется") : entry.phase === "success" ? t("Успешно")
      : entry.phase === "timeout" ? t("Время ожидания истекло") : entry.exit_code === null ? t("Ошибка запуска") : t(`Ошибка (код ${entry.exit_code})`);
    phase.setAttribute("aria-label", phase.title);
    while (entries.size > LIMIT) {
      const oldest = Math.min(...entries.keys());
      entries.delete(oldest); rows.get(oldest)?.remove(); rows.delete(oldest);
    }
    const running = [...entries.values()].filter((entry) => entry.phase === "running").length;
    status.textContent = running ? t(`Выполняется команд: ${running}`) : t("Готово");
    count.textContent = t(`Команд в логе: ${entries.size}`);
    if (atBottom) entriesEl.scrollTop = entriesEl.scrollHeight;
  }

  let unlisten: (() => void) | undefined;
  count.textContent = t("Команд в логе: 0");
  try {
    // Subscribe first: a completion arriving while history loads must not be overwritten by an old snapshot.
    unlisten = await listen<Entry>("vkcs-command-log", (event) => merge(event.payload));
    // History is optional and must not delay loading the cloud's resources.
    void invoke<Entry[]>("vkcs_command_log").then((history) => {
      for (const entry of history) merge(entry);
    }).catch(() => { if (!entries.size) status.textContent = t("Лог недоступен"); });
  } catch { status.textContent = t("Лог недоступен"); }
  window.addEventListener("beforeunload", () => { unlisten?.(); observer.disconnect(); }, { once: true });
}
