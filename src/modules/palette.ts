import { esc, overlay } from "./ui";

/** One entry of the command palette. Modules contribute entries through providers. */
export type PaletteItem = { group: string; title: string; hint?: string; run: () => void | Promise<void> };
type Provider = () => PaletteItem[] | Promise<PaletteItem[]>;

const providers: Provider[] = [];
export function registerProvider(p: Provider) {
  providers.push(p);
}

/** Subsequence match with bonuses for word starts and consecutive chars; 0 = no match. */
function score(query: string, text: string): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  let s = 0, ti = 0, streak = 0;
  for (const ch of query) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return 0;
    streak = i === ti ? streak + 1 : 0;
    s += 1 + streak * 2 + (i === 0 || " /-_.:".includes(t[i - 1]) ? 3 : 0);
    ti = i + 1;
  }
  return s - t.length * 0.01;
}

let el: HTMLElement | null = null;

export async function openPalette() {
  if (el) return;
  el = document.createElement("div");
  el.className = "palette-backdrop";
  el.innerHTML = `<div class="palette">
      <input class="palette-q" placeholder="Команда, контекст, заметка, сниппет, история…" spellcheck="false" />
      <div class="palette-list"><p class="muted pad">загрузка…</p></div>
      <div class="palette-foot muted">↑↓ выбрать · Enter выполнить · Esc закрыть</div>
    </div>`;
  document.body.appendChild(el);
  overlay(true);
  const input = el.querySelector<HTMLInputElement>("input")!;
  const list = el.querySelector<HTMLElement>(".palette-list")!;
  input.focus();

  const close = () => { if (el) overlay(false); el?.remove(); el = null; };
  el.addEventListener("mousedown", (e) => { if (e.target === el) close(); });

  const results = await Promise.all(providers.map(async (p) => { try { return await p(); } catch { return []; } }));
  const all = results.flat();
  let shown: PaletteItem[] = [];
  let sel = 0;

  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = all
      .map((it) => ({ it, s: score(q, `${it.group} ${it.title}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => (q ? b.s - a.s : 0))
      .slice(0, 80)
      .map((x) => x.it);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.innerHTML = shown.map((it, i) => `
      <div class="palette-item ${i === sel ? "sel" : ""}" data-i="${i}">
        <span class="palette-group">${esc(it.group)}</span>
        <span class="palette-title">${esc(it.title)}</span>
        ${it.hint ? `<span class="palette-hint">${esc(it.hint)}</span>` : ""}
      </div>`).join("") || `<p class="muted pad">Ничего не найдено</p>`;
    list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  };

  const run = async (i: number) => {
    const it = shown[i];
    if (!it) return;
    close();
    await it.run();
  };

  input.addEventListener("input", () => { sel = 0; draw(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") { sel = Math.min(sel + 1, shown.length - 1); draw(); }
    else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); draw(); }
    else if (e.key === "Enter") run(sel);
    else return;
    e.preventDefault();
  });
  list.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".palette-item");
    if (row) run(Number(row.dataset.i));
  });
  draw();
}

// Ctrl+Shift+P everywhere (Ctrl+K is kill-line in bash, so it stays with the shell)
window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement | null)?.closest(".keybinding-record.recording")) return;
  if (e.ctrlKey && e.shiftKey && (e.code === "KeyP" || e.key.toUpperCase() === "P")) {
    e.preventDefault();
    e.stopPropagation();
    openPalette();
  }
}, true);
window.addEventListener("open-palette", () => openPalette());
