import { t } from "../i18n";
import { invoke } from "@tauri-apps/api/core";
import { registerProvider } from "./palette";
import { ask, esc, toast } from "./ui";
import { icon } from "./icons";

export type Snippet = { id: string; title: string; command: string; tags: string[] };

const PARAM = /\{\{\s*([\w.-]+)(?::([^}]*))?\s*\}\}/g;

export const snippetsList = () => invoke<Snippet[]>("snippets_list");
const saveAll = (snippets: Snippet[]) => invoke("snippets_save", { snippets });

/** Fills {{name}} / {{name:default}} placeholders, then pastes into the active terminal (not executed). */
export async function runSnippet(s: Snippet) {
  const names = new Map<string, string>();
  for (const m of s.command.matchAll(PARAM)) if (!names.has(m[1])) names.set(m[1], m[2] ?? "");
  const values = new Map<string, string>();
  for (const [name, def] of names) {
    const v = await ask(s.title, `Значение для ${name}:`, { input: def, ok: "Далее" });
    if (v === null) return;
    values.set(name, v);
  }
  const cmd = s.command.replace(PARAM, (_m, n: string) => values.get(n) ?? "");
  const { terminalApi } = await import("./terminal");
  terminalApi.paste(cmd);
}

/** "★" on a command block: save it as a snippet. */
export async function addSnippet(command: string) {
  const title = await ask("Новый сниппет", "Название (параметры в команде можно отметить как {{имя}} или {{имя:по умолчанию}}):", { input: command.slice(0, 60), ok: "Сохранить" });
  if (!title) return;
  const list = await snippetsList().catch(() => [] as Snippet[]);
  list.push({ id: crypto.randomUUID(), title, command, tags: [] });
  await saveAll(list).then(() => toast("Сниппет сохранён — найдите его в палитре Ctrl+Shift+P"), (e) => toast(String(e), "err"));
  window.dispatchEvent(new Event("snippets-changed"));
}

registerProvider(async () =>
  (await snippetsList()).map((s) => ({ group: "Сниппет", title: s.title, hint: s.command, run: () => runSnippet(s) })));

/** Snippet manager, rendered inside the settings page. */
export function mountSnippets(el: HTMLElement) {
  el.innerHTML = `
    <div class="row sn-head"><span class="muted">Команды с параметрами <code>${t("{{имя}}")}</code> — запуск через палитру (Ctrl+Shift+P). Команда вставляется в терминал, Enter жмёте вы.</span>
      <button type="button" class="primary" data-a="add">${icon("plus", 16)} Сниппет</button></div>
    <table class="res sn-table"><tbody></tbody></table>
    <dialog class="sn-dialog">
      <form method="dialog">
        <h3>Сниппет</h3>
        <label>Название <input name="title" required /></label>
        <label>Команда <textarea name="command" rows="4" required spellcheck="false" placeholder="kubectl -n {{ns:default}} logs -f deploy/{{name}}"></textarea></label>
        <label>Теги (через запятую) <input name="tags" /></label>
        <div class="actions"><button value="cancel" formnovalidate>Отмена</button><button value="ok" class="primary">Сохранить</button></div>
      </form>
    </dialog>`;
  const tbody = el.querySelector("tbody")!;
  const dlg = el.querySelector<HTMLDialogElement>("dialog")!;
  const form = dlg.querySelector("form")!;
  const f = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
  let list: Snippet[] = [];
  let editing: Snippet | null = null;

  const draw = async () => {
    list = await snippetsList().catch(() => []);
    tbody.innerHTML = list.map((s, i) => `<tr data-i="${i}">
      <td>${esc(s.title)}</td><td class="muted sn-cmd">${esc(s.command)}</td>
      <td class="sn-acts"><button type="button" class="icon" data-a="edit">${icon("edit", 14)}</button><button type="button" class="icon danger" data-a="del">${icon("trash", 14)}</button></td></tr>`).join("")
      || `<tr><td class="muted">Пока нет сниппетов. Их можно сохранять кнопкой ★ над блоком команды в терминале.</td></tr>`;
  };
  const open = (s: Snippet | null) => {
    editing = s;
    form.reset();
    f("title").value = s?.title ?? "";
    f("command").value = s?.command ?? "";
    f("tags").value = s?.tags.join(", ") ?? "";
    dlg.showModal();
  };
  form.addEventListener("submit", async (e) => {
    if ((e.submitter as HTMLButtonElement | null)?.value !== "ok") return;
    e.preventDefault();
    const s: Snippet = {
      id: editing?.id ?? crypto.randomUUID(), title: f("title").value.trim(), command: f("command").value.trim(),
      tags: f("tags").value.split(",").map((t) => t.trim()).filter(Boolean),
    };
    const next = editing ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s];
    try { await saveAll(next); dlg.close(); draw(); } catch (err) { toast(String(err), "err"); }
  });
  el.addEventListener("click", async (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-a]")?.dataset.a;
    const i = Number((e.target as HTMLElement).closest<HTMLElement>("tr")?.dataset.i);
    if (a === "add") open(null);
    if (a === "edit") open(list[i]);
    if (a === "del" && (await ask("Удалить сниппет", `Удалить «${list[i].title}»?`, { ok: "Удалить", danger: true })) !== null) {
      await saveAll(list.filter((_, j) => j !== i));
      draw();
    }
  });
  window.addEventListener("snippets-changed", draw);
  draw();
}
