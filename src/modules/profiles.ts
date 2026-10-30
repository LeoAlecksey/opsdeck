/**
 * Окружения: несколько независимых рабочих мест (хосты, кластеры, пароли, раскладка) в одной
 * установке. Каждое окружение — отдельный экземпляр приложения со своим окном (profile.rs), поэтому
 * здесь только выбор, создание, подпись и запуск: внутри окна окружение не переключается.
 *
 * Сведения об окружении окна бэкенд кладёт в `window.__OPSDECK_PROFILE__` до загрузки страницы —
 * так страница сразу знает, рисовать рабочее место или выбор окружения.
 */
import { invoke } from "@tauri-apps/api/core";
import { esc, overlay, toast } from "./ui";
import { t } from "../i18n";
import { COLORS, DEFAULT_ID, displayName, initials, normColor } from "./profilekit";

export { DEFAULT_ID };


export type Boot = { id: string; name: string; color: string; several: boolean; picker: boolean; notice: string };
export type Profile = { id: string; name: string; color: string; current: boolean; open: boolean };
type List = { profiles: Profile[]; start: string; picker: boolean };


export function bootInfo(): Boot {
  const b = (window as unknown as { __OPSDECK_PROFILE__?: Partial<Boot> | null }).__OPSDECK_PROFILE__;
  return {
    id: b?.id || DEFAULT_ID,
    name: b?.name ?? "",
    color: normColor(b?.color ?? ""),
    several: !!b?.several,
    picker: !!b?.picker,
    notice: b?.notice ?? "",
  };
}


const nameOf = (p: { id: string; name: string }) => displayName(p, t("Основное"));

/** Цвет окружения на всём окне: полоса слева у боковой колонки (и у вынесенных окон). */
export function markWindow() {
  const b = bootInfo();
  if (!b.several || !b.color) return;
  document.body.classList.add("has-profile");
  document.body.style.setProperty("--profile-color", b.color);
}

const swatches = (name: string, current: string) =>
  `<span class="profile-colors">${["", ...COLORS].map((c) =>
    `<label class="profile-color${c ? "" : " none"}" ${c ? `style="--c:${c}"` : ""} title="${c ? esc(c) : esc(t("Без цвета"))}"><input type="radio" name="${name}" value="${c}" ${c === current ? "checked" : ""} /></label>`).join("")}</span>`;

const row = (p: Profile, action: string) => `
  <li class="profile-row${p.current ? " current" : ""}">
    <span class="profile-dot" style="--c:${normColor(p.color) || "var(--border-hover)"}"></span>
    <span class="profile-name" data-no-i18n>${esc(nameOf(p))}</span>
    ${p.current ? `<span class="muted">${esc(t("это окно"))}</span>` : p.open ? `<span class="muted">${esc(t("открыто в другом окне"))}</span>` : ""}
    <span class="spacer"></span>
    ${p.current || p.open ? "" : `<button type="button" class="ghost" data-open="${esc(p.id)}">${esc(action)}</button>`}
  </li>`;

async function load(): Promise<List> {
  return invoke<List>("profiles_list");
}

/** Форма нового окружения; `copy` — показывать ли выбор «копия текущего». */
const createForm = (copy: boolean) => `
  <details class="profile-new">
    <summary>Новое окружение</summary>
    <label>Название <input name="pname" maxlength="40" spellcheck="false" placeholder="например, Прод или Stage EU" /></label>
    <div class="profile-color-row"><span class="muted">Цвет метки</span>${swatches("pcolor", COLORS[0])}</div>
    ${copy ? `<label class="check"><input type="radio" name="pcopy" value="0" checked /> Пустое: свои хосты, кластеры и пароли, общие только заметки и ИИ-модели</label>
    <label class="check"><input type="radio" name="pcopy" value="1" /> Копия текущего: те же хосты, кластеры, веб-панели и настройки — без паролей, их нужно ввести заново</label>` : ""}
    <div class="row"><button type="button" class="primary" data-create>Создать и открыть</button></div>
  </details>`;

async function create(root: HTMLElement): Promise<string | null> {
  const name = root.querySelector<HTMLInputElement>("[name=pname]")!.value.trim();
  if (!name) {
    toast(t("Введите название окружения"), "err");
    return null;
  }
  const color = root.querySelector<HTMLInputElement>("[name=pcolor]:checked")?.value ?? "";
  const copy = root.querySelector<HTMLInputElement>("[name=pcopy]:checked")?.value === "1";
  try {
    return await invoke<string>("profile_create", { name, color, copy });
  } catch (e) {
    toast(String(e), "err");
    return null;
  }
}

/** Окружения из рабочего места: открыть другое, создать, подписать текущее, что открывать при запуске. */
export async function openProfilesDialog() {
  let list: List;
  try {
    list = await load();
  } catch (e) {
    toast(String(e), "err");
    return;
  }
  const me = list.profiles.find((p) => p.current);
  const dlg = document.createElement("dialog");
  dlg.className = "ask profiles-dlg";
  const draw = () => {
    dlg.innerHTML = `
      <form method="dialog">
        <h3>Окружения</h3>
        <p class="muted hint">Окружение — отдельное рабочее место: свои SSH-хосты, кластеры, базы, веб-панели, пароли и раскладка. Каждое открывается в своём окне, и работать можно в нескольких сразу. Общие — ИИ-модели и, пока не выбрана другая, папка заметок.</p>
        <ul class="profile-list">${list.profiles.map((p) => row(p, t("Открыть"))).join("")}</ul>
        ${me ? `<fieldset class="profile-edit"><legend>Это окружение</legend>
          <label>Название <input name="ename" maxlength="40" spellcheck="false" value="${esc(me.name)}" placeholder="${esc(nameOf({ id: me.id, name: "" }))}" /></label>
          <div class="profile-color-row"><span class="muted">Цвет метки</span>${swatches("ecolor", normColor(me.color))}</div>
          <div class="row"><button type="button" class="ghost" data-save>Сохранить</button></div>
        </fieldset>` : ""}
        ${createForm(true)}
        <label class="profile-start">При запуске открывать <select name="start">
          <option value="">— спрашивать —</option>
          ${list.profiles.map((p) => `<option value="${esc(p.id)}" ${p.id === list.start ? "selected" : ""} data-no-i18n>${esc(nameOf(p))}</option>`).join("")}
        </select></label>
        <div class="actions"><button value="cancel" formnovalidate>Закрыть</button></div>
      </form>`;
  };
  draw();
  dlg.addEventListener("click", async (e) => {
    const el = e.target as HTMLElement;
    const open = el.closest<HTMLElement>("[data-open]")?.dataset.open;
    if (open) {
      try {
        await invoke("profile_open", { id: open });
        toast(t("Окружение открывается в новом окне"));
        dlg.close();
      } catch (err) { toast(String(err), "err"); }
      return;
    }
    if (el.closest("[data-save]")) {
      const name = dlg.querySelector<HTMLInputElement>("[name=ename]")!.value.trim();
      const color = dlg.querySelector<HTMLInputElement>("[name=ecolor]:checked")?.value ?? "";
      try {
        await invoke("profile_update", { name, color });
        toast(t("Сохранено, метка обновится при следующем запуске окна"));
      } catch (err) { toast(String(err), "err"); }
      return;
    }
    if (el.closest("[data-create]")) {
      const id = await create(dlg);
      if (!id) return;
      try {
        await invoke("profile_open", { id });
        toast(t("Окружение создано и открывается в новом окне"));
        dlg.close();
      } catch (err) { toast(String(err), "err"); }
    }
  });
  dlg.addEventListener("change", async (e) => {
    const sel = (e.target as HTMLElement).closest<HTMLSelectElement>("select[name=start]");
    if (!sel) return;
    try { await invoke("profile_start_set", { id: sel.value }); } catch (err) { toast(String(err), "err"); }
  });
  document.body.appendChild(dlg);
  overlay(true);
  dlg.addEventListener("close", () => { overlay(false); dlg.remove(); });
  dlg.showModal();
}

/** Метка окружения вверху боковой колонки: видно, в каком окне работаешь; клик — окружения. */
export function mountProfileBadge(sidebar: HTMLElement) {
  const b = bootInfo();
  if (!b.several) return;
  const name = nameOf(b);
  const btn = document.createElement("button");
  btn.className = "profile-badge";
  btn.title = t("Окружение: {}. Открыть другое или создать новое").replace("{}", name);
  btn.style.setProperty("--c", b.color || "var(--border-hover)");
  btn.textContent = initials(name);
  btn.dataset.noI18n = "";
  btn.onclick = () => openProfilesDialog();
  sidebar.prepend(btn);
}

/** Окно выбора окружения при запуске, когда окружений несколько. */
export async function mountPicker(root: HTMLElement) {
  const b = bootInfo();
  root.innerHTML = `
    <div class="picker">
      <h2>OpsDeck</h2>
      <p class="muted">Выберите окружение</p>
      ${b.notice ? `<p class="warn picker-notice">${esc(b.notice)}</p>` : ""}
      <ul class="profile-list"></ul>
      <label class="check"><input type="checkbox" name="remember" /> Запомнить выбор и больше не спрашивать</label>
      ${createForm(false)}
    </div>`;
  const ul = root.querySelector<HTMLElement>(".profile-list")!;
  const refresh = async () => {
    try {
      const list = await load();
      ul.innerHTML = list.profiles.map((p) => row(p, t("Открыть"))).join("");
    } catch (e) { ul.innerHTML = `<li class="err">${esc(String(e))}</li>`; }
  };
  root.addEventListener("click", async (e) => {
    const el = e.target as HTMLElement;
    const id = el.closest<HTMLElement>("[data-open]")?.dataset.open;
    if (id) {
      try {
        if (root.querySelector<HTMLInputElement>("[name=remember]")!.checked) await invoke("profile_start_set", { id });
        // окно закроется само: окружение открывается отдельным процессом
        await invoke("profile_pick", { id });
      } catch (err) { toast(String(err), "err"); refresh(); }
      return;
    }
    if (el.closest("[data-create]")) {
      const made = await create(root);
      if (!made) return;
      root.querySelector<HTMLInputElement>("[name=pname]")!.value = "";
      root.querySelector<HTMLDetailsElement>(".profile-new")!.open = false;
      await refresh();
    }
  });
  await refresh();
}
