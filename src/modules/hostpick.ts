import { invoke } from "@tauri-apps/api/core";
import { targets, type Target } from "./monitor";
import { natCmp } from "./natsort";
import { esc, overlay } from "./ui";

/** Choose an SSH host (a profile or a Host from ~/.ssh/config) in a small dialog with a filter; null when cancelled. */
export function pickSshHost(): Promise<Target | null> {
  const dlg = document.createElement("dialog");
  dlg.className = "host-pick";
  dlg.innerHTML = `
    <form method="dialog">
      <h3>SSH-хост для новой панели</h3>
      <input class="hp-filter" placeholder="фильтр…" spellcheck="false" autocomplete="off" />
      <div class="hp-list"></div>
      <div class="actions"><button value="cancel" formnovalidate>Отмена</button></div>
    </form>`;
  document.body.appendChild(dlg);
  overlay(true);
  const list = dlg.querySelector<HTMLElement>(".hp-list")!;
  const filter = dlg.querySelector<HTMLInputElement>(".hp-filter")!;
  let all: Target[] = [];
  let chosen: Target | null = null;

  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = all.filter((t) => !q || `${t.name} ${t.group} ${t.addr}`.toLowerCase().includes(q));
    list.innerHTML = shown.length
      ? shown.map((t) => `<button type="button" class="hp-item" data-k="${esc(t.key)}"><b>${esc(t.name)}</b><span class="muted">${esc(t.group ? t.group + " · " : "")}${esc(t.addr)}</span></button>`).join("")
      : `<p class="muted">${all.length ? "Ничего не найдено" : "Хостов нет — добавьте их в разделе SSH или в ~/.ssh/config"}</p>`;
  };
  const choose = (key: string | undefined) => {
    chosen = all.find((t) => t.key === key) ?? null;
    if (chosen) dlg.close("ok");
  };
  filter.addEventListener("input", draw);
  filter.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); choose(list.querySelector<HTMLElement>(".hp-item")?.dataset.k); }
  });
  list.addEventListener("click", (e) => choose((e.target as HTMLElement).closest<HTMLElement>(".hp-item")?.dataset.k));

  invoke<Parameters<typeof targets>[0]>("ssh_list")
    .catch(() => ({ hosts: [], config: [] }))
    .then((l) => {
      all = targets(l).sort((a, b) => natCmp(a.group, b.group) || natCmp(a.name, b.name));
      draw();
    });

  return new Promise((resolve) => {
    dlg.addEventListener("close", () => {
      overlay(false);
      resolve(dlg.returnValue === "ok" ? chosen : null);
      dlg.remove();
    });
    dlg.showModal();
    filter.focus();
  });
}
