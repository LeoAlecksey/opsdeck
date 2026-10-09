import { helpBtn } from "./help";
import { icon } from "./icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { esc, toast } from "./ui";
import { registerProvider } from "./palette";

export type PbStatus = {
  configured: boolean; unlocked: boolean; mfa: string[]; url: string; user: string; server_fingerprint: string;
  entries: number; unreadable: number; warnings: string[]; lock_minutes: number; keep_open: boolean;
};
export type PbEntry = {
  id: string; kind: string; title: string; username: string; url: string; group: string;
  has_password: boolean; has_notes: boolean;
};
type AccountInfo = { url: string; user: string; name: string; server_fingerprint: string };

export const pbStatus = () => invoke<PbStatus>("pb_status");
export const pbEntries = (query = "") => invoke<PbEntry[]>("pb_entries", { query });

const MFA_LABEL: Record<string, string> = { totp: "Код из приложения (TOTP)", yubikey: "Коснитесь Yubikey" };
/** fingerprint in groups of four, as Passbolt shows it */
const fp = (s: string) => s.replace(/(.{4})/g, "$1 ").trim();

/** Import of the account: an account kit, or a recovery kit with the address. */
/** Import of the account from an account kit. */
function importForm(el: HTMLElement, done: () => void) {
  el.innerHTML = `
    <form class="kp-unlock pb-import">
      <div class="kp-lock-icon">${icon("lock", 48)}</div>
      <p class="muted">Passbolt ещё не подключён. Нужен <b>account kit</b>: в Passbolt — профиль → «Desktop app setup» → скачать файл <code>account-kit.passbolt</code>.</p>
      <button type="button" class="primary" data-a="kit">Выбрать account kit…</button>
      <p class="err kp-err"></p>
    </form>`;
  const form = el.querySelector("form")!;
  const errEl = form.querySelector(".kp-err")!;
  const run = async (btn: HTMLButtonElement, job: () => Promise<AccountInfo>) => {
    errEl.textContent = "";
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Проверяю…";
    try {
      const a = await job();
      toast(`Passbolt подключён: ${a.user} на ${a.url}. Отпечаток ключа сервера: ${fp(a.server_fingerprint)}`);
      done();
    } catch (e) { errEl.textContent = String(e); }
    finally { btn.disabled = false; btn.textContent = label; }
  };
  const kitBtn = form.querySelector<HTMLButtonElement>("[data-a=kit]")!;
  kitBtn.onclick = async () => {
    const path = await invoke<string | null>("pb_pick_file");
    if (path) run(kitBtn, () => invoke<AccountInfo>("pb_import_kit", { path }));
  };
}

/** Second factor asked by the server after the passphrase. */
function mfaForm(el: HTMLElement, st: PbStatus, done: () => void) {
  el.innerHTML = `
    <form class="kp-unlock">
      <div class="kp-lock-icon">${icon("lock", 48)}</div>
      <div class="muted kp-path"></div>
      ${st.mfa.length > 1 ? `<select name="provider">${st.mfa.map((p) => `<option value="${esc(p)}">${esc(MFA_LABEL[p] ?? p)}</option>`).join("")}</select>` : ""}
      <input name="code" autocomplete="one-time-code" spellcheck="false" />
      <label class="check"><input type="checkbox" name="remember" /> Запомнить на этом компьютере на 30 дней</label>
      <p class="err kp-err"></p>
      <div class="row"><button type="button" data-a="cancel">Отмена</button><button class="primary" type="submit">Войти</button></div>
    </form>`;
  const form = el.querySelector("form")!;
  const code = form.elements.namedItem("code") as HTMLInputElement;
  const provider = () => (form.elements.namedItem("provider") as HTMLSelectElement | null)?.value ?? st.mfa[0];
  const sync = () => {
    form.querySelector(".kp-path")!.textContent = `Второй фактор для ${st.user}`;
    code.placeholder = MFA_LABEL[provider()] ?? "Код";
  };
  form.querySelector("select")?.addEventListener("change", sync);
  sync();
  form.querySelector<HTMLElement>("[data-a=cancel]")!.onclick = () => invoke("pb_lock").then(done);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    btn.disabled = true;
    try {
      await invoke("pb_mfa", { provider: provider(), code: code.value, remember: (form.elements.namedItem("remember") as HTMLInputElement).checked });
      done();
    } catch (err) {
      form.querySelector(".kp-err")!.textContent = String(err);
      code.select();
      // too many wrong codes end the session on the server
      if (!(await pbStatus()).mfa.length) done();
    } finally { btn.disabled = false; }
  };
  requestAnimationFrame(() => code.focus());
}

/** Unlock form (or import / MFA, whichever is due) rendered into `el`. */
function unlockForm(el: HTMLElement, st: PbStatus, onUnlocked: () => void) {
  const again = () => pbStatus().then((s) => (s.unlocked ? onUnlocked() : unlockForm(el, s, onUnlocked)));
  if (!st.configured) return importForm(el, again);
  if (st.mfa.length) return mfaForm(el, st, again);
  el.innerHTML = `
    <form class="kp-unlock">
      <div class="kp-lock-icon">${icon("lock", 48)}</div>
      <div class="muted kp-path"></div>
      <input type="password" name="pw" placeholder="Парольная фраза ключа Passbolt" autocomplete="off" />
      <p class="err kp-err"></p>
      <button class="primary" type="submit">Разблокировать</button>
      <button type="button" class="ghost" data-a="forget">Подключить другой аккаунт</button>
    </form>`;
  el.querySelector(".kp-path")!.textContent = `${st.user} · ${st.url}`;
  const form = el.querySelector("form")!;
  const pw = form.querySelector<HTMLInputElement>("input")!;
  const btn = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  form.querySelector<HTMLElement>("[data-a=forget]")!.onclick = async () => {
    if (!confirm("Отключить этот аккаунт Passbolt? Ключ будет удалён с этого компьютера; подключиться снова можно по account kit.")) return;
    await invoke("pb_forget").catch((e) => toast(String(e), "err"));
    again();
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = "Вхожу…";
    try {
      await invoke("pb_unlock", { passphrase: pw.value });
      pw.value = "";
      again();
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

registerProvider(async () => {
  if (!(await pbStatus()).unlocked) return [];
  return (await pbEntries()).filter((e) => e.has_password).map((e) => ({
    group: "Passbolt", title: `Пароль: ${e.title}`, hint: [e.username, e.group].filter(Boolean).join(" · "),
    run: () => invoke("pb_copy", { id: e.id, field: "password" }).then(() => toast(`Пароль «${e.title}» скопирован, очистится через 30 с`), (x) => toast(String(x), "err")),
  }));
});

export function mountPassbolt(root: HTMLElement) {
  root.innerHTML = `<div class="page kp"><div class="kp-body"></div></div>`;
  const body = root.querySelector<HTMLElement>(".kp-body")!;
  let selected: PbEntry | null = null;

  async function render() {
    const st = await pbStatus();
    if (!st.unlocked) {
      body.innerHTML = `<div class="kp-locked"></div>
        <div class="kp-foot">${st.configured ? `<button class="ghost" data-a="web">Открыть Passbolt в браузере</button>` : ""}${helpBtn("passbolt")}</div>`;
      unlockForm(body.querySelector<HTMLElement>(".kp-locked")!, st, render);
      body.querySelector<HTMLElement>("[data-a=web]")?.addEventListener("click", () => invoke("pb_open_external", { id: null }).catch((e) => toast(String(e), "err")));
      return;
    }
    body.innerHTML = `
      <div class="page-head">
        <h2>Passbolt <span class="muted small-note"></span></h2>
        <div class="row">
          <button class="ghost" data-a="reload" title="Перечитать список с сервера">${icon("refresh", 16)}</button>
          <button class="ghost" data-a="web">В браузере</button>
          <button data-a="lock">${icon("lock", 16)} Заблокировать</button>
          ${helpBtn("passbolt")}
        </div>
      </div>
      <div class="pb-warn warn" hidden></div>
      <input class="kp-search" placeholder="поиск: имя, логин, URL, папка" spellcheck="false" />
      <div class="kp-split">
        <div class="kp-table-wrap"><table class="res kp-table"><thead><tr><th>Название</th><th>Логин</th><th>URL</th><th>Папка</th><th></th></tr></thead><tbody></tbody></table></div>
        <aside class="kp-detail" hidden></aside>
      </div>`;
    const showStatus = (x: PbStatus) => {
      body.querySelector(".small-note")!.textContent =
        `${x.user} · ${x.entries} записей · только чтение · ${x.keep_open ? "открыт до закрытия приложения" : `автоблокировка ${x.lock_minutes ? `через ${x.lock_minutes} мин` : "выключена"}`}`;
      const warn = body.querySelector<HTMLElement>(".pb-warn")!;
      warn.hidden = !x.warnings.length;
      warn.innerHTML = x.warnings.map((w) => `<div>⚠ ${esc(w)}</div>`).join("");
    };
    showStatus(st);
    body.querySelector<HTMLElement>("[data-a=lock]")!.onclick = () => invoke("pb_lock");
    body.querySelector<HTMLElement>("[data-a=web]")!.onclick = () => invoke("pb_open_external", { id: selected?.id ?? null }).catch((e) => toast(String(e), "err"));
    body.querySelector<HTMLElement>("[data-a=reload]")!.onclick = async () => {
      showStatus(await invoke<PbStatus>("pb_reload").catch((e) => { toast(String(e), "err"); return st; }));
      await draw();
    };

    const search = body.querySelector<HTMLInputElement>(".kp-search")!;
    const tbody = body.querySelector("tbody")!;
    let entries: PbEntry[] = [];
    const draw = async () => {
      entries = await pbEntries(search.value).catch((e) => { toast(String(e), "err"); return []; });
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
    await draw();
    search.focus();
  }

  async function copy(e: PbEntry, field: string) {
    try {
      await invoke("pb_copy", { id: e.id, field });
      toast(field === "password" ? `Пароль «${e.title}» скопирован, очистится через 30 с` : "Скопировано");
    } catch (err) { toast(String(err), "err"); }
  }

  async function showDetail(e: PbEntry) {
    const d = body.querySelector<HTMLElement>(".kp-detail")!;
    d.hidden = false;
    const row = (label: string, value: string, field?: string, secret = false) => `
      <div class="kp-field"><div class="muted">${label}</div>
        <div class="kp-val"><span class="${secret ? "kp-secret" : ""}">${secret ? "••••••••••" : esc(value)}</span>
        ${secret ? `<button class="icon" data-r title="Показать на 10 с">👁</button>` : ""}
        ${field ? `<button class="icon" data-c="${field}" title="Скопировать">⧉</button>` : ""}</div></div>`;
    // the description is in the secret for most types: it is fetched (and logged by Passbolt) on demand
    d.innerHTML = `<h3>${esc(e.title)}</h3>
      ${e.group ? `<div class="muted">${esc(e.group)}</div>` : ""}
      ${row("Логин", e.username, "username")}
      ${e.has_password ? row("Пароль", "", "password", true) : ""}
      ${e.url ? row("URL", e.url, "url") : ""}
      ${e.has_notes ? `<div class="kp-field"><div class="muted">Описание</div><button class="ghost" data-n>Показать описание</button><pre class="kp-notes" hidden></pre></div>` : ""}`;
    d.onclick = async (ev) => {
      const t = ev.target as HTMLElement;
      const field = t.closest<HTMLElement>("[data-c]")?.dataset.c;
      if (field) return copy(e, field);
      if (t.closest("[data-r]")) {
        const span = d.querySelector<HTMLElement>(".kp-secret")!;
        span.textContent = await invoke<string>("pb_reveal", { id: e.id }).catch((x) => String(x));
        setTimeout(() => (span.textContent = "••••••••••"), 10000);
      }
      if (t.closest("[data-n]")) {
        const pre = d.querySelector<HTMLElement>(".kp-notes")!;
        pre.textContent = await invoke<string>("pb_notes", { id: e.id }).catch((x) => String(x));
        pre.hidden = false;
        t.closest<HTMLElement>("[data-n]")!.remove();
      }
    };
  }

  listen<string | null>("pb-locked", (e) => {
    selected = null;
    if (e.payload) toast(e.payload, "err");
    render();
  });
  window.addEventListener("view-shown", (e) => { if ((e as CustomEvent).detail === "passbolt") render(); });
  render();
}
