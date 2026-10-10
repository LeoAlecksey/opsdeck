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

/** Modal UI is about to cover the page: embedded web panels (native views on top) hide meanwhile. */
export function overlay(open: boolean) {
  window.dispatchEvent(new Event(open ? "overlay-open" : "overlay-close"));
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
