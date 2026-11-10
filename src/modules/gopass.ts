import { helpBtn } from "./help-btn";
import { icon } from "./icons";
import { invoke } from "@tauri-apps/api/core";
import { esc, overlay, toast } from "./ui";
import { registerProvider } from "./palette";

/** gopass — только чтение, как Passbolt: список путей, копирование логина и пароля, выбор записи
 *  для SSH, баз, MikroTik и веб-панелей. Расшифровывает gpg-agent: пароль ключа спросит его окно. */
export type GpStatus = { installed: boolean; version: string; ready: boolean; error: string };
export type GpEntry = { id: string; title: string; folder: string };

export const gpStatus = () => invoke<GpStatus>("gp_status");
export const gpEntries = (query = "") => invoke<GpEntry[]>("gp_entries", { query });

const copied = (e: GpEntry, field: string) => (field === "password" ? `Пароль «${e.title}» скопирован, очистится через 30 с` : "Скопировано");

async function copy(e: GpEntry, field: string) {
  try {
    await invoke("gp_copy", { id: e.id, field });
    toast(copied(e, field));
  } catch (err) { toast(String(err), "err"); }
}

/** Что показать вместо списка, если gopass не готов. */
function notReady(st: GpStatus): string {
  return st.installed
    ? `<p>${esc(st.error)}</p><p class="muted">gopass ${esc(st.version)} установлен, но хранилище не читается. Создать: <code>gopass init</code>, взять из git: <code>gopass clone &lt;репозиторий&gt;</code>.</p>`
    : `<p>${esc(st.error)}</p><p class="muted">gopass — менеджер паролей на GPG и git, совместимый с <code>pass</code>: <a href="https://www.gopass.pw/" data-ext>gopass.pw</a>.</p>`;
}

/** Выбор записи для коннекторов, SSH, баз и MikroTik. */
export function pickEntry(): Promise<GpEntry | null> {
  const dlg = document.createElement("dialog");
  dlg.className = "kp-picker";
  dlg.innerHTML = `<h3>Запись gopass</h3><div class="kp-picker-body"></div>
    <div class="actions"><button data-a="cancel">Отмена</button></div>`;
  document.body.appendChild(dlg);
  overlay(true);
  const body = dlg.querySelector<HTMLElement>(".kp-picker-body")!;

  return new Promise((resolve) => {
    let result: GpEntry | null = null;
    dlg.addEventListener("close", () => { overlay(false); dlg.remove(); resolve(result); });
    dlg.querySelector<HTMLElement>("[data-a=cancel]")!.onclick = () => dlg.close();
    body.innerHTML = `<input class="kp-q" placeholder="поиск по пути: infra/prod/grafana" spellcheck="false" /><div class="kp-plist"></div>`;
    const q = body.querySelector<HTMLInputElement>(".kp-q")!;
    const list = body.querySelector<HTMLElement>(".kp-plist")!;
    let entries: GpEntry[] = [];
    const draw = async () => {
      try {
        entries = await gpEntries(q.value);
      } catch (e) {
        list.innerHTML = `<p class="err">${esc(String(e))}</p>`;
        return;
      }
      list.innerHTML = entries.slice(0, 200).map((e, i) => `
        <button class="kp-pitem" data-i="${i}"><span>${esc(e.title)}</span><span class="muted">${esc(e.folder)}</span></button>`).join("")
        || `<p class="muted">Ничего не найдено</p>`;
    };
    list.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>(".kp-pitem");
      if (b) { result = entries[Number(b.dataset.i)]; dlg.close(); }
    };
    let t = 0;
    q.oninput = () => { clearTimeout(t); t = window.setTimeout(draw, 120); };
    dlg.showModal();
    draw();
    q.focus();
  });
}

/** Палитра ищет по gopass только после того, как раздел открывался и хранилище прочиталось:
 *  иначе каждый запуск дёргал бы `gopass ls` и у тех, у кого gopass нет. */
let storeSeen = false;

registerProvider(async () => {
  if (!storeSeen) return [];
  const entries = await gpEntries().catch(() => [] as GpEntry[]);
  return entries.map((e) => ({
    group: "gopass", title: `Пароль: ${e.title}`, hint: e.folder,
    run: () => copy(e, "password"),
  }));
});

export function mountGopass(root: HTMLElement) {
  root.innerHTML = `<div class="page kp"><div class="kp-body"></div></div>`;
  const body = root.querySelector<HTMLElement>(".kp-body")!;

  async function render() {
    const st = await gpStatus();
    if (!st.ready) {
      body.innerHTML = `<div class="page-head"><h2>gopass</h2><div class="row">
          <button class="ghost" data-a="retry">${icon("refresh", 16)} Проверить снова</button>${helpBtn("gopass")}</div></div>
        <div class="gp-missing">${notReady(st)}</div>`;
      body.querySelector<HTMLElement>("[data-a=retry]")!.onclick = render;
      return;
    }
    storeSeen = true;
    body.innerHTML = `
      <div class="page-head">
        <h2>gopass <span class="muted small-note">${esc(st.version)} · только чтение</span></h2>
        <div class="row">
          <button class="ghost" data-a="reload" title="Перечитать список">${icon("refresh", 16)}</button>
          <button data-a="forget" title="Забыть расшифрованное в памяти OpsDeck (кэш gpg-agent — отдельно)">${icon("lock", 16)} Забыть</button>
          ${helpBtn("gopass")}
        </div>
      </div>
      <input class="kp-search" placeholder="поиск по пути: infra/prod/grafana" spellcheck="false" />
      <div class="kp-table-wrap"><table class="res kp-table"><thead><tr><th>Запись в хранилище</th><th>Папка</th><th></th></tr></thead><tbody></tbody></table></div>`;
    const search = body.querySelector<HTMLInputElement>(".kp-search")!;
    const tbody = body.querySelector("tbody")!;
    let entries: GpEntry[] = [];
    const draw = async () => {
      entries = await gpEntries(search.value).catch((e) => { toast(String(e), "err"); return []; });
      tbody.innerHTML = entries.map((e, i) => `
        <tr data-i="${i}"><td>${esc(e.title)}</td><td class="muted">${esc(e.folder)}</td>
          <td class="kp-acts">
            <button class="icon" data-c="username" title="Скопировать логин (строка user:, username: или login:)">${icon("user", 14)}</button>
            <button class="icon" data-c="password" title="Скопировать пароль (очистится через 30 с)">${icon("key", 14)}</button>
          </td></tr>`).join("") || `<tr><td colspan="3" class="muted">Ничего не найдено</td></tr>`;
    };
    tbody.onclick = (ev) => {
      const t = ev.target as HTMLElement;
      const tr = t.closest<HTMLElement>("tr[data-i]");
      const field = t.closest<HTMLElement>("[data-c]")?.dataset.c;
      if (tr && field) copy(entries[Number(tr.dataset.i)], field);
    };
    body.querySelector<HTMLElement>("[data-a=reload]")!.onclick = draw;
    body.querySelector<HTMLElement>("[data-a=forget]")!.onclick = () => invoke("gp_forget").then(() => toast("Расшифрованное забыто"));
    let timer = 0;
    search.oninput = () => { clearTimeout(timer); timer = window.setTimeout(draw, 120); };
    await draw();
    search.focus();
  }

  body.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-ext]");
    if (!a) return;
    e.preventDefault();
    invoke("open_external", { url: a.href }).catch(() => {});
  });
  window.addEventListener("view-shown", (e) => { if ((e as CustomEvent).detail === "gopass") render(); });
  render();
}
