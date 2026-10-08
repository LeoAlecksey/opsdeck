import { locale } from "../i18n";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, esc, toast } from "./ui";

type UpdateInfo = { current: string; available: boolean; version?: string; notes?: string; date?: number; rollback?: boolean };
type Release = { version: string; date: string | null; notes: string; withdrawn: boolean; installable: boolean };

let last: UpdateInfo | null = null;

/** "↑" on the ⚙ button while a newer version is available. */
function badge(on: boolean) {
  const b = document.querySelector<HTMLElement>("#sidebar [data-view=settings]");
  if (!b) return;
  b.classList.toggle("has-update", on);
  b.title = !on ? "Настройки" : last?.rollback ? `Настройки — версия ${last.current} отозвана, вернитесь на ${last.version}` : `Настройки — доступна OpsDeck ${last?.version}`;
}

export async function checkUpdates(silent = false): Promise<UpdateInfo | null> {
  try {
    last = await invoke<UpdateInfo>("update_check");
    badge(last.available);
    if (last.available && silent) {
      toast(last.rollback
        ? `Версия ${last.current} отозвана из-за критической ошибки — ⚙ Настройки → Обновления: вернуться на ${last.version}`
        : `Доступна OpsDeck ${last.version} — ⚙ Настройки → Обновления`, last.rollback ? "err" : "ok");
    }
    window.dispatchEvent(new CustomEvent("update-info", { detail: last }));
    return last;
  } catch (e) {
    if (!silent) throw e;
    return null;
  }
}

/** Settings section: current version, check button, release notes, install with progress. */
export function mountUpdates(el: HTMLElement) {
  el.innerHTML = `
    <div class="row"><span>Установлена версия <b class="upd-cur">…</b></span><span class="spacer"></span>
      <button type="button" class="ghost" data-u="check">Проверить обновления</button></div>
    <div class="upd-result muted"></div>
    <div class="upd-new" hidden>
      <div class="row"><b class="upd-title"></b><span class="spacer"></span><button type="button" class="primary" data-u="install">Обновить и перезапустить</button></div>
      <pre class="upd-notes"></pre>
      <div class="upd-progress" hidden><div class="upd-bar"></div></div>
    </div>
    <details class="upd-other">
      <summary>Другие версии — откатиться, если новая работает плохо</summary>
      <div class="upd-list muted">загрузка…</div>
    </details>`;
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => el.querySelector<T>(s)!;

  const show = (u: UpdateInfo) => {
    $(".upd-cur").textContent = u.current;
    $(".upd-new").hidden = !u.available;
    $(".upd-result").textContent = u.available ? "" : "✓ Это последняя версия";
    $(".upd-new").classList.toggle("rollback", !!u.rollback);
    if (u.available) {
      const when = u.date ? ` от ${new Date(u.date * 1000).toLocaleDateString(locale())}` : "";
      $(".upd-title").textContent = u.rollback
        ? `Версия ${u.current} отозвана (критическая ошибка). Стабильная версия: ${u.version}${when}`
        : `Доступна версия ${u.version}${when}`;
      $("[data-u=install]").textContent = u.rollback ? `Вернуться на ${u.version}` : "Обновить и перезапустить";
      $(".upd-notes").innerHTML = esc(u.notes?.trim() || "Описание изменений — на странице релиза на GitHub.");
    }
  };

  el.addEventListener("click", async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-u]")?.dataset.u;
    if (act === "check") {
      $(".upd-result").textContent = "Проверяю…";
      try { const u = await checkUpdates(); if (u) show(u); } catch (err) { $(".upd-result").textContent = String(err); }
    }
    if (act === "pick") {
      const v = (e.target as HTMLElement).closest<HTMLElement>("[data-v]")!.dataset.v!;
      const older = cmpVer(v, current()) < 0;
      const ok = await ask(older ? `Откатиться на ${v}` : `Установить ${v}`,
        `${older ? "Будет установлена более старая версия" : "Будет установлена версия"} ${v} (подпись проверяется так же, как при обновлении), затем OpsDeck перезапустится. Настройки и данные сохраняются; новые настройки, которых не было в ${v}, вернутся к значениям по умолчанию после следующего обновления.`,
        { ok: older ? "Откатиться" : "Установить", danger: older });
      if (ok === null) return;
      await installVersion(v, (e.target as HTMLElement).closest<HTMLButtonElement>("button")!);
    }
    if (act === "install") {
      const btn = $<HTMLButtonElement>("[data-u=install]");
      btn.disabled = true;
      btn.textContent = "Скачиваю…";
      $(".upd-progress").hidden = false;
      try {
        await invoke("update_install", { version: last?.rollback ? last.version : null }); // restarts the app on success
      } catch (err) {
        toast(String(err), "err");
        btn.disabled = false;
        btn.textContent = last?.rollback ? `Вернуться на ${last.version}` : "Обновить и перезапустить";
        $(".upd-progress").hidden = true;
      }
    }
  });

  const current = () => $(".upd-cur").textContent ?? "";
  let busyBtn: HTMLButtonElement | null = null;
  async function installVersion(v: string, btn: HTMLButtonElement) {
    busyBtn = btn;
    el.querySelectorAll<HTMLButtonElement>("[data-u=pick]").forEach((b) => (b.disabled = true));
    btn.textContent = "Скачиваю…";
    try {
      await invoke("update_install", { version: v });
    } catch (err) {
      toast(String(err), "err");
      busyBtn = null;
      loadList();
    }
  }

  async function loadList() {
    const box = $(".upd-list");
    try {
      const list = await invoke<Release[]>("releases_list");
      const cur = current();
      box.classList.remove("muted");
      box.innerHTML = list.length ? list.map((r) => `
        <div class="upd-rel ${r.withdrawn ? "withdrawn" : ""}" title="${esc(r.notes.slice(0, 600))}">
          <b>${esc(r.version)}</b>
          <span class="muted">${r.date ? new Date(r.date).toLocaleDateString(locale()) : ""}</span>
          ${r.withdrawn ? `<span class="upd-tag bad">отозвана</span>` : ""}
          ${r.version === cur ? `<span class="upd-tag">установлена</span>` : ""}
          <span class="spacer"></span>
          ${r.version !== cur && r.installable && !r.withdrawn
            ? `<button type="button" class="ghost" data-u="pick" data-v="${esc(r.version)}">${cmpVer(r.version, cur) < 0 ? "Откатиться" : "Установить"}</button>`
            : r.version !== cur && !r.installable ? `<span class="muted small">нет файлов обновления</span>` : ""}
        </div>`).join("") : "Релизов пока нет";
    } catch (err) {
      box.textContent = String(err);
    }
  }
  $(".upd-other").addEventListener("toggle", () => { if ((($(".upd-other") as HTMLDetailsElement).open)) loadList(); });

  listen<{ downloaded?: number; total?: number | null; installing?: boolean }>("update-progress", (e) => {
    const p = e.payload;
    const btn = busyBtn ?? $<HTMLButtonElement>("[data-u=install]");
    if (p.installing) { btn.textContent = "Устанавливаю… приложение перезапустится"; $(".upd-bar").style.width = "100%"; return; }
    if (p.total) $(".upd-bar").style.width = `${Math.min(100, (100 * (p.downloaded ?? 0)) / p.total)}%`;
    btn.textContent = `Скачиваю… ${((p.downloaded ?? 0) / 1048576).toFixed(1)} МБ${p.total ? ` из ${(p.total / 1048576).toFixed(1)}` : ""}`;
  });
  window.addEventListener("update-info", (e) => show((e as CustomEvent<UpdateInfo>).detail));
  if (last) show(last);
  else invoke<UpdateInfo>("update_check").then(show).catch((err) => {
    // not reachable / no releases yet: still show the installed version
    invoke<string>("app_version").then((v) => ($(".upd-cur").textContent = v)).catch(() => {});
    $(".upd-result").textContent = String(err);
  });
}

function cmpVer(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0), pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}
