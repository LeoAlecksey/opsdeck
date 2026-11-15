import { nextZoom, parseZoom, zoomKey } from "./zoom";

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Modal confirm / prompt. Resolves to the entered value ("" for plain confirm) or null on cancel.
 * Used instead of window.confirm/prompt, which webviews don't reliably support.
 */
export function ask(
  title: string,
  message: string,
  opts: { input?: string; placeholder?: string; ok?: string; danger?: boolean } = {},
): Promise<string | null> {
  const dlg = document.createElement("dialog");
  dlg.className = "ask";
  dlg.innerHTML = `
    <form method="dialog">
      <h3>${esc(title)}</h3>
      <p class="msg">${esc(message)}</p>
      ${opts.input !== undefined ? `<input name="v" value="${esc(opts.input)}" placeholder="${esc(opts.placeholder ?? "")}" spellcheck="false" autocomplete="off" />` : ""}
      <div class="actions">
        <button value="cancel" formnovalidate>Отмена</button>
        <button value="ok" class="${opts.danger ? "danger-solid" : "primary"}">${esc(opts.ok ?? "OK")}</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  overlay(true);
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => {
      overlay(false);
      const input = dlg.querySelector("input");
      resolve(dlg.returnValue === "ok" ? (input?.value.trim() ?? "") : null);
      dlg.remove();
    });
    dlg.showModal();
    dlg.querySelector<HTMLInputElement>("input")?.select();
  });
}

/**
 * Enter in a dialog field means its main action, not «Отмена».
 *
 * The browser submits a form by Enter through its *first* submit button, and in every dialog here that is
 * «Отмена» — so Enter closed the dialog and threw the typed values away (#68, and the same in notes, SSH,
 * databases…). One listener covers every dialog, including ones added later.
 */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  const target = e.target as HTMLElement | null;
  // a textarea takes Enter as a newline; on a button Enter means that button
  if (!target || target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement) return;
  const form = target.closest("form");
  if (!form || !form.closest("dialog")?.open) return;
  const main = form.querySelector<HTMLButtonElement>("button.primary:not([hidden]), button.danger-solid:not([hidden])");
  if (!main || main.disabled) return;
  e.preventDefault();
  main.click();
});

/** Modal UI is about to cover the page: embedded web panels (native views on top) hide meanwhile. */
export function overlay(open: boolean) {
  window.dispatchEvent(new Event(open ? "overlay-open" : "overlay-close"));
}

/**
 * Скопировать текст. Сначала средствами самого окна: тогда владельцем выделения остаётся webview,
 * и вставка внутри приложения обслуживается им же. Когда выделением владеет бэкенд (arboard), на
 * X11 запрос к владельцу ждёт до 4 секунд — в журнале это выглядит как зависание интерфейса
 * примерно на столько же. Если доступ к буферу из окна закрыт, пишем через бэкенд, как раньше.
 * Секреты (пароли, токены) идут мимо: у них свой путь с очисткой через 30 секунд.
 */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch { /* нет доступа из окна — пишем через бэкенд */ }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("clip_write", { text });
}

/** Write to the app log file (errors shown to the user, uncaught exceptions). */
export function logUi(level: "error" | "warn" | "info", message: string) {
  import("@tauri-apps/api/core").then(({ invoke }) => invoke("log_ui", { level, message }).catch(() => {}));
}

export function toast(text: string, kind: "ok" | "err" = "ok") {
  if (kind === "err") logUi("error", text);
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), kind === "err" ? 7000 : 3000);
}

/** Context menu at a point: [label, action, danger?]; closes on any click. */
export function popupMenu(rect: { left: number; top: number; bottom: number }, items: [string, () => void, boolean?][]) {
  document.querySelector(".ctx-menu")?.remove();
  const m = document.createElement("div");
  m.className = "ctx-menu";
  m.innerHTML = items.map(([label, , danger], i) => `<div class="ctx-item ${danger ? "danger" : ""}" data-i="${i}">${esc(label)}</div>`).join("");
  document.body.appendChild(m);
  const x = Math.min(rect.left, window.innerWidth - m.offsetWidth - 8);
  const y = rect.bottom + m.offsetHeight > window.innerHeight ? rect.top - m.offsetHeight : rect.bottom;
  m.style.left = `${x}px`;
  m.style.top = `${Math.max(4, y)}px`;
  m.onclick = (e) => { const i = (e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i; m.remove(); if (i !== undefined) items[Number(i)][1](); };
  setTimeout(() => document.addEventListener("click", () => m.remove(), { once: true }), 0);
}

/** Колесо над `el`, клавиши — в разделе `scope`; `apply` вызывается сразу с сохранённым масштабом и после каждого шага. */
export function attachZoom(el: HTMLElement, key: string, apply: (scale: number) => void, scope: HTMLElement = el) {
  let scale = 1;
  try { scale = parseZoom(localStorage.getItem(key)); } catch { /* ignore */ }
  apply(scale);
  const set = (step: number) => {
    const next = nextZoom(scale, step);
    if (next !== scale) {
      scale = next;
      try { localStorage.setItem(key, String(scale)); } catch { /* ignore */ }
      apply(scale);
    }
    toast(`Масштаб ${Math.round(scale * 100)}%`);
  };
  // клавиши — когда раздел на экране и фокус в нём (или нигде: после клика по тексту заметки);
  // во встроенной консоли Ctrl+= остаётся шрифтом терминала
  window.addEventListener("keydown", (e) => {
    const step = zoomKey(e);
    if (step === null || scope.offsetParent === null) return;
    const target = e.target as HTMLElement;
    if (!(scope.contains(target) || target === document.body) || target.closest?.(".xterm")) return;
    e.preventDefault();
    e.stopPropagation();
    set(step);
  }, true);
  el.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    set(e.deltaY < 0 ? 1 : -1);
  }, { passive: false, capture: true });
}
