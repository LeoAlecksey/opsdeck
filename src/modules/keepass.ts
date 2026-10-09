import { helpBtn } from "./help";
import { icon } from "./icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { esc, overlay, toast } from "./ui";
import { registerProvider } from "./palette";

export type KpStatus = { unlocked: boolean; path: string; keyfile: string; entries: number; lock_minutes: number; keep_open: boolean };
export type KpEntry = {
  id: string; title: string; username: string; url: string; group: string;
  tags: string[]; has_password: boolean; has_notes: boolean;
};

export const kpStatus = () => invoke<KpStatus>("kp_status");
export const kpEntries = (query = "") => invoke<KpEntry[]>("kp_entries", { query });

/** Unlock form rendered into `el`; resolves once the database is open. */
function unlockForm(el: HTMLElement, st: KpStatus, onUnlocked: () => void) {
  el.innerHTML = `
    <form class="kp-unlock">
      <div class="kp-lock-icon">${icon("lock", 48)}</div>
      <div class="muted kp-path"></div>
      <input type="password" name="pw" placeholder="Мастер-пароль" autocomplete="off" />
      <p class="err kp-err"></p>
      <button class="primary" type="submit">Разблокировать</button>
    </form>`;
  el.querySelector(".kp-path")!.textContent = (st.path || "путь к .kdbx не задан — см. настройки ⚙") + (st.keyfile ? " + ключевой файл" : "");
  const form = el.querySelector("form")!;
  const pw = form.querySelector<HTMLInputElement>("input")!;
  const btn = form.querySelector<HTMLButtonElement>("button")!;
  form.onsubmit = async (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = "Открываю…";
    try {
      await invoke("kp_unlock", { password: pw.value });
      pw.value = "";
      onUnlocked();
    } catch (err) {
      form.querySelector(".kp-err")!.textContent = String(err);
      pw.select();
    } finally {
      btn.disabled = false;
      btn.textContent = "Разблокировать";
    }
  };
  requestAnimationFrame(() => pw.focus());
}

/** Modal picker used by connectors and MikroTik to bind credentials to a KeePass entry. */
export function pickEntry(): Promise<KpEntry | null> {
  const dlg = document.createElement("dialog");
  dlg.className = "kp-picker";
  dlg.innerHTML = `<h3>Запись KeePass</h3><div class="kp-picker-body"></div>
    <div class="actions"><button data-a="cancel">Отмена</button></div>`;
  document.body.appendChild(dlg);
  overlay(true);
  const body = dlg.querySelector<HTMLElement>(".kp-picker-body")!;

  return new Promise((resolve) => {
    let result: KpEntry | null = null;
    dlg.addEventListener("close", () => { overlay(false); dlg.remove(); resolve(result); });
    dlg.querySelector<HTMLElement>("[data-a=cancel]")!.onclick = () => dlg.close();

    const showList = () => {
      body.innerHTML = `<input class="kp-q" placeholder="поиск: имя, логин, URL, группа" spellcheck="false" /><div class="kp-plist"></div>`;
      const q = body.querySelector<HTMLInputElement>(".kp-q")!;
      const list = body.querySelector<HTMLElement>(".kp-plist")!;
      let entries: KpEntry[] = [];
      const draw = async () => {
        entries = await kpEntries(q.value).catch(() => []);
        list.innerHTML = entries.slice(0, 200).map((e, i) => `
          <button class="kp-pitem" data-i="${i}"><span>${esc(e.title || "(без названия)")}</span>
          <span class="muted">${esc(e.username)}${e.group ? " · " + esc(e.group) : ""}</span></button>`).join("")
          || `<p class="muted">Ничего не найдено</p>`;
      };
      list.onclick = (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>(".kp-pitem");
        if (b) { result = entries[Number(b.dataset.i)]; dlg.close(); }
      };
      let t = 0;
      q.oninput = () => { clearTimeout(t); t = window.setTimeout(draw, 120); };
      draw();
      q.focus();
    };

    dlg.showModal();
    kpStatus().then((st) => (st.unlocked ? showList() : unlockForm(body, st, showList)));
  });
}

registerProvider(async () => {
  if (!(await kpStatus()).unlocked) return [];
  return (await kpEntries()).filter((e) => e.has_password).map((e) => ({
    group: "KeePass", title: `Пароль: ${e.title}`, hint: [e.username, e.group].filter(Boolean).join(" · "),
    run: () => invoke("kp_copy", { id: e.id, field: "password" }).then(() => toast(`Пароль «${e.title}» скопирован, очистится через 30 с`), (x) => toast(String(x), "err")),
  }));
});

export function mountKeepass(root: HTMLElement) {
  root.innerHTML = `<div class="page kp"><div class="kp-body"></div></div>`;
  const body = root.querySelector<HTMLElement>(".kp-body")!;
  let selected: KpEntry | null = null;
  /** redraws the open table in place (keeps the search text); null while locked */
  let refresh: (() => Promise<void>) | null = null;

  async function render() {
    const st = await kpStatus();
    if (!st.unlocked) {
      refresh = null;
      body.innerHTML = `<div class="kp-locked"></div>
        <div class="kp-foot"><button class="ghost" data-a="xc">Открыть в KeePassXC</button>${helpBtn("vault")}</div>`;
      unlockForm(body.querySelector<HTMLElement>(".kp-locked")!, st, render);
      body.querySelector<HTMLElement>("[data-a=xc]")!.onclick = () => invoke("kp_open_external").catch((e) => toast(String(e), "err"));
      return;
    }
    body.innerHTML = `
      <div class="page-head">
        <h2>KeePass <span class="muted small-note"></span></h2>
        <div class="row">
          <button class="ghost" data-a="xc">KeePassXC</button>
          <button data-a="lock">${icon("lock", 16)} Заблокировать</button>
          ${helpBtn("vault")}
        </div>
      </div>
      <input class="kp-search" placeholder="поиск: имя, логин, URL, группа, тег" spellcheck="false" />
      <div class="kp-split">
        <div class="kp-table-wrap"><table class="res kp-table"><thead><tr><th>Название</th><th>Логин</th><th>URL</th><th>Группа</th><th></th></tr></thead><tbody></tbody></table></div>
        <aside class="kp-detail" hidden></aside>
      </div>`;
    const noteText = (x: KpStatus) =>
      `${x.entries} записей · только чтение · ${x.keep_open ? "открыта до закрытия OpsDeck" : `автоблокировка ${x.lock_minutes ? `через ${x.lock_minutes} мин` : "выключена"}`} · изменения файла подтягиваются сами`;
    body.querySelector(".small-note")!.textContent = noteText(st);
    body.querySelector<HTMLElement>("[data-a=lock]")!.onclick = () => invoke("kp_lock");
    body.querySelector<HTMLElement>("[data-a=xc]")!.onclick = () => invoke("kp_open_external").catch((e) => toast(String(e), "err"));

    const search = body.querySelector<HTMLInputElement>(".kp-search")!;
    const tbody = body.querySelector("tbody")!;
    let entries: KpEntry[] = [];
    const draw = async () => {
      entries = await kpEntries(search.value).catch((e) => { toast(String(e), "err"); return []; });
      tbody.innerHTML = entries.map((e, i) => `
        <tr data-i="${i}" class="${selected?.id === e.id ? "sel" : ""}">
          <td>${esc(e.title)}</td><td>${esc(e.username)}</td><td class="muted">${esc(e.url)}</td><td class="muted">${esc(e.group)}</td>
          <td class="kp-acts">
            ${e.username ? `<button class="icon" data-c="username" title="Скопировать логин">${icon("user", 14)}</button>` : ""}
            ${e.has_password ? `<button class="icon" data-c="password" title="Скопировать пароль (очистится через 30 с)">${icon("key", 14)}</button>` : ""}
          </td></tr>`).join("");
    };
    tbody.onclick = async (ev) => {
      const t = ev.target as HTMLElement;
      const tr = t.closest("tr");
      if (!tr) return;
      const e = entries[Number(tr.dataset.i)];
      const field = t.closest<HTMLElement>("[data-c]")?.dataset.c;
      if (field) return copy(e, field);
      selected = e;
      tbody.querySelectorAll("tr").forEach((r) => r.classList.toggle("sel", r === tr));
      showDetail(e);
    };
    let timer = 0;
    search.oninput = () => { clearTimeout(timer); timer = window.setTimeout(draw, 120); };
    refresh = async () => {
      const s2 = await kpStatus();
      const note = body.querySelector(".small-note");
      if (note) note.textContent = noteText(s2);
      await draw();
      // the open card may describe an entry that changed or was deleted
      const again = selected && entries.find((x) => x.id === selected!.id);
      if (again) { selected = again; showDetail(again); }
      else if (selected) { selected = null; body.querySelector<HTMLElement>(".kp-detail")!.hidden = true; }
    };
    await draw();
    search.focus();
  }

  async function copy(e: KpEntry, field: string) {
    try {
      await invoke("kp_copy", { id: e.id, field });
      toast(field === "password" ? `Пароль «${e.title}» скопирован, очистится через 30 с` : "Скопировано");
    } catch (err) { toast(String(err), "err"); }
  }

  async function showDetail(e: KpEntry) {
    const d = body.querySelector<HTMLElement>(".kp-detail")!;
    d.hidden = false;
    const row = (label: string, value: string, field?: string, secret = false) => `
      <div class="kp-field"><div class="muted">${label}</div>
        <div class="kp-val"><span class="${secret ? "kp-secret" : ""}">${secret ? "••••••••••" : esc(value)}</span>
        ${secret ? `<button class="icon" data-r title="Показать на 10 с">👁</button>` : ""}
        ${field ? `<button class="icon" data-c="${field}" title="Скопировать">⧉</button>` : ""}</div></div>`;
    d.innerHTML = `<h3>${esc(e.title)}</h3>
      ${e.group ? `<div class="muted">${esc(e.group)}</div>` : ""}
      ${row("Логин", e.username, "username")}
      ${e.has_password ? row("Пароль", "", "password", true) : ""}
      ${e.url ? row("URL", e.url, "url") : ""}
      ${e.tags.length ? row("Теги", e.tags.join(", ")) : ""}
      ${e.has_notes ? `<div class="kp-field"><div class="muted">Заметки</div><pre class="kp-notes">…</pre></div>` : ""}`;
    let shown = false, hideTimer = 0, reveals = 0;
    d.onclick = async (ev) => {
      const t = ev.target as HTMLElement;
      const field = t.closest<HTMLElement>("[data-c]")?.dataset.c;
      if (field) return copy(e, field);
      const eye = t.closest<HTMLElement>("[data-r]");
      if (eye) {
        const span = d.querySelector<HTMLElement>(".kp-secret")!;
        // a toggle: a second click hides the password (it used to fetch it again and start one more timer)
        const hide = () => {
          clearTimeout(hideTimer);
          shown = false;
          span.textContent = "••••••••••";
          eye.title = "Показать на 10 с";
        };
        if (shown) return hide();
        shown = true;
        eye.title = "Скрыть";
        const ticket = ++reveals;
        const pw = await invoke<string>("kp_reveal", { id: e.id }).catch((x) => String(x));
        // hidden (or shown anew) while the password was being fetched: this answer is stale
        if (!shown || ticket !== reveals) return;
        span.textContent = pw;
        hideTimer = window.setTimeout(hide, 10000);
      }
    };
    if (e.has_notes) d.querySelector(".kp-notes")!.textContent = await invoke<string>("kp_notes", { id: e.id }).catch((x) => String(x));
  }

  listen("kp-locked", () => { selected = null; render(); });
  listen("kp-changed", () => {
    toast("База KeePass изменилась — список обновлён");
    if (refresh) refresh(); else render();
  });
  listen<string>("kp-reload-failed", (e) => toast(e.payload, "err"));
  window.addEventListener("view-shown", (e) => { if ((e as CustomEvent).detail === "vault") render(); });
  render();
}
