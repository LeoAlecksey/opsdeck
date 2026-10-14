import { locale, t } from "../i18n";
import { icon } from "./icons";
import { invoke } from "@tauri-apps/api/core";
import { ask, esc, toast } from "./ui";
import { helpBtn } from "./help";
import { natCmp } from "./natsort";
import { fmtSize, joinPath } from "./paths";

/** Запись удалённой папки (sftp.rs) и локальной (fs_list): `modified` — как показал sftp,
 *  `modified_at` и `modified` (число) — секунды эпохи, по ним сортируем и показываем дату. */
type Entry = { name: string; dir: boolean; link?: boolean; size: number; modified?: string | number; modified_at?: number; perms?: string; target?: string };
type Sort = { col: "name" | "size" | "date"; dir: 1 | -1 };
type Listing = { path: string; entries: Entry[] };
type SshHost = { id: string; name: string; group: string; host: string; user: string };
type ConfigHost = { alias: string; group: string; hostname: string; user: string };
type SshList = { hosts: SshHost[]; config: ConfigHost[] };

const LOCAL = "local";
const KEY = (side: string) => `opsdeck.sftp.${side}`;

export function mountSftp(root: HTMLElement) {
  const pane = (side: string) => `
    <div class="fx2-pane" data-side="${side}">
      <div class="fx2-top row">
        <select class="fx2-host" title="Где смотрим файлы"></select>
        <button class="icon" data-a="up" title="На уровень выше">↑</button>
        <input class="fx2-path mono" spellcheck="false" placeholder="/" />
        <button class="icon" data-a="refresh" title="Обновить">${icon("refresh", 16)}</button>
      </div>
      <div class="fx2-body"><table class="fx2-list">
        <thead><tr><th data-s="name">Имя</th><th data-s="size" class="fx2-s">Размер</th><th data-s="date" class="fx2-d">Изменён</th></tr></thead>
        <tbody></tbody></table></div>
      <div class="fx2-foot row">
        <button class="ghost" data-a="mkdir">${icon("plus", 14)} Папка</button>
        <button class="ghost" data-a="ren">Переименовать</button>
        <button class="ghost danger" data-a="del">${icon("trash", 14)} Удалить</button>
        <span class="spacer"></span><span class="fx2-status muted"></span>
      </div>
    </div>`;

  root.innerHTML = `
    <div class="page sftp">
      <div class="page-head">
        <h2>Файлы на хостах ${helpBtn("sftp")}</h2>
        <span class="muted hint">Выделите файлы и перетащите в соседнюю панель или нажмите стрелку. Вход по ключу.</span>
      </div>
      <div class="fx2">
        ${pane("a")}
        <div class="fx2-mid">
          <button class="primary" data-a="to-b" title="Скопировать выделенное из левой панели в правую">→</button>
          <button class="primary" data-a="to-a" title="Скопировать выделенное из правой панели в левую">←</button>
        </div>
        ${pane("b")}
      </div>
    </div>`;

  type Side = {
    el: HTMLElement; target: string; path: string; entries: Entry[]; sel: Set<string>; sort: Sort;
    host: HTMLSelectElement; pathEl: HTMLInputElement; body: HTMLElement; status: HTMLElement;
  };

  const make = (el: HTMLElement): Side => ({
    el, target: LOCAL, path: "", entries: [], sel: new Set(), sort: { col: "name", dir: 1 },
    host: el.querySelector<HTMLSelectElement>(".fx2-host")!,
    pathEl: el.querySelector<HTMLInputElement>(".fx2-path")!,
    body: el.querySelector<HTMLElement>(".fx2-body")!,
    status: el.querySelector<HTMLElement>(".fx2-status")!,
  });
  const sides: Record<"a" | "b", Side> = {
    a: make(root.querySelector<HTMLElement>('.fx2-pane[data-side="a"]')!),
    b: make(root.querySelector<HTMLElement>('.fx2-pane[data-side="b"]')!),
  };
  const isLocal = (s: Side) => s.target === LOCAL;

  async function fillHosts() {
    const l = await invoke<SshList>("ssh_list").catch(() => ({ hosts: [], config: [] }) as SshList);
    const opts = [`<option value="${LOCAL}">Эта машина</option>`,
      ...[...l.hosts].sort((a, b) => natCmp(a.name, b.name)).map((h) => `<option value="id:${esc(h.id)}">${esc(h.name)}</option>`),
      ...[...l.config].sort((a, b) => natCmp(a.alias, b.alias)).map((h) => `<option value="alias:${esc(h.alias)}">${esc(h.alias)} (config)</option>`)].join("");
    for (const s of Object.values(sides)) {
      s.host.innerHTML = opts;
      const saved = localStorage.getItem(KEY(s.el.dataset.side!));
      if (saved && s.host.querySelector(`option[value="${CSS.escape(saved)}"]`)) s.target = saved;
      s.host.value = s.target;
    }
  }

  async function load(s: Side, select: string[] = []) {
    s.sel.clear();
    s.status.textContent = "…";
    try {
      const l = isLocal(s)
        ? { path: s.path || "~", entries: await invoke<Entry[]>("fs_list", { path: s.path || "~", hidden: true }) }
        : await invoke<Listing>("sftp_list", { target: s.target, path: s.path });
      s.path = l.path;
      s.entries = l.entries;
      s.pathEl.value = l.path;
      s.status.textContent = `${l.entries.length} ${l.entries.length === 1 ? "объект" : "объектов"}`;
    } catch (e) {
      s.entries = [];
      s.status.textContent = String(e);
    }
    for (const n of select) if (s.entries.some((e) => e.name === n)) s.sel.add(n);
    draw(s);
    if (s.sel.size) {
      const first = s.body.querySelector<HTMLElement>("tr.sel");
      first?.scrollIntoView({ block: "nearest" });
    }
  }

  /** Время записи: у хоста приходит строкой и числом, у своей машины — только числом. */
  const when = (e: Entry) => (typeof e.modified_at === "number" && e.modified_at ? e.modified_at : typeof e.modified === "number" ? e.modified : 0);
  const dateFmt = new Intl.DateTimeFormat(locale(), { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const dateText = (e: Entry) => {
    const t = when(e);
    if (t) return dateFmt.format(new Date(t * 1000));
    return typeof e.modified === "string" ? e.modified : "";
  };

  /** Порядок строк: папки всегда сверху, дальше — по выбранной колонке. */
  function sorted(s: Side): Entry[] {
    const by = (a: Entry, b: Entry) =>
      s.sort.col === "size" ? a.size - b.size : s.sort.col === "date" ? when(a) - when(b) : natCmp(a.name, b.name);
    return [...s.entries].sort((a, b) => Number(b.dir) - Number(a.dir) || by(a, b) * s.sort.dir || natCmp(a.name, b.name));
  }

  function draw(s: Side) {
    const rows = sorted(s).map((e) => `
      <tr data-name="${esc(e.name)}" class="${s.sel.has(e.name) ? "sel" : ""}${e.dir ? " dir" : ""}">
        <td class="fx2-n">${e.dir ? icon("folder", 14) : ""}${esc(e.name)}${e.link && e.target ? `<span class="muted"> → ${esc(e.target)}</span>` : ""}</td>
        <td class="fx2-s mono">${e.dir ? "" : fmtSize(e.size)}</td>
        <td class="fx2-d muted">${esc(dateText(e))}</td>
      </tr>`).join("");
    s.body.querySelector("tbody")!.innerHTML = `<tr data-name=".." class="dir up"><td colspan="3">↑ ..</td></tr>${rows}`;
    for (const th of s.body.querySelectorAll<HTMLElement>("th[data-s]")) {
      th.classList.toggle("asc", th.dataset.s === s.sort.col && s.sort.dir > 0);
      th.classList.toggle("desc", th.dataset.s === s.sort.col && s.sort.dir < 0);
    }
  }

  /** Только классы выделения: перерисовка таблицы на клике съедала двойной клик. */
  function syncSel(s: Side) {
    for (const tr of s.body.querySelectorAll<HTMLElement>("tr[data-name]")) {
      tr.classList.toggle("sel", s.sel.has(tr.dataset.name!));
    }
  }

  function wire(s: Side) {
    s.host.onchange = () => {
      s.target = s.host.value;
      s.path = "";
      try { localStorage.setItem(KEY(s.el.dataset.side!), s.target); } catch { /* ignore */ }
      load(s);
    };
    // Клик по шапке — порядок строк; дата и размер сначала по убыванию: обычно ищут свежее и крупное
    s.body.addEventListener("click", (e) => {
      const th = (e.target as HTMLElement).closest<HTMLElement>("th[data-s]");
      if (!th) return;
      const col = th.dataset.s as Sort["col"];
      s.sort = s.sort.col === col ? { col, dir: s.sort.dir === 1 ? -1 : 1 } : { col, dir: col === "name" ? 1 : -1 };
      draw(s);
    });
    s.el.querySelector<HTMLElement>("[data-a=refresh]")!.onclick = () => load(s);
    s.el.querySelector<HTMLElement>("[data-a=up]")!.onclick = () => { s.path = joinPath(s.path, ".."); load(s); };
    s.pathEl.onchange = () => { s.path = s.pathEl.value.trim(); load(s); };

    s.body.addEventListener("click", (e) => {
      const tr = (e.target as HTMLElement).closest<HTMLElement>("tr[data-name]");
      if (!tr) return;
      const name = tr.dataset.name!;
      if (name === "..") return;
      if (e.ctrlKey || e.metaKey) s.sel.has(name) ? s.sel.delete(name) : s.sel.add(name);
      else { s.sel.clear(); s.sel.add(name); }
      syncSel(s);
    });
    s.body.addEventListener("dblclick", (e) => {
      const tr = (e.target as HTMLElement).closest<HTMLElement>("tr[data-name]");
      if (!tr) return;
      const name = tr.dataset.name!;
      const entry = s.entries.find((x) => x.name === name);
      if (name !== ".." && !entry?.dir) return;
      s.path = joinPath(s.path, name);
      load(s);
    });

    s.el.querySelector<HTMLElement>("[data-a=mkdir]")!.onclick = async () => {
      const name = await ask("Новая папка", `Имя папки в «${s.path}»`, { ok: "Создать", input: "", placeholder: "release-2026-10" });
      if (!name) return;
      const full = joinPath(s.path, name);
      try {
        if (isLocal(s)) await invoke("code_create", { path: full, dir: true });
        else await invoke("sftp_mkdir", { target: s.target, path: full });
        load(s);
      } catch (e) { toast(String(e), "err"); }
    };
    s.el.querySelector<HTMLElement>("[data-a=ren]")!.onclick = async () => {
      const [name] = [...s.sel];
      if (!name) return toast("Выделите файл или папку", "err");
      const to = await ask("Переименовать", `Новое имя для «${name}»`, { ok: "Переименовать", input: name });
      if (!to || to === name) return;
      try {
        if (isLocal(s)) await invoke("code_rename", { root: s.path, from: joinPath(s.path, name), to: joinPath(s.path, to) });
        else await invoke("sftp_rename", { target: s.target, from: joinPath(s.path, name), to: joinPath(s.path, to) });
        load(s);
      } catch (e) { toast(String(e), "err"); }
    };
    s.el.querySelector<HTMLElement>("[data-a=del]")!.onclick = async () => {
      const names = [...s.sel];
      if (!names.length) return toast("Выделите, что удалить", "err");
      if ((await ask("Удалить", `Удалить ${names.length === 1 ? `«${names[0]}»` : `${names.length} объектов`} из «${s.path}»?`, { ok: "Удалить", danger: true })) === null) return;
      for (const n of names) {
        const dir = !!s.entries.find((x) => x.name === n)?.dir;
        try {
          if (isLocal(s)) await invoke("code_delete", { root: s.path, path: joinPath(s.path, n) });
          else await invoke("sftp_delete", { target: s.target, path: joinPath(s.path, n), dir });
        } catch (e) { toast(String(e), "err"); }
      }
      load(s);
    };
  }

  /** Копирование между панелями: своя машина ↔ хост через sftp, хост → хост через scp -3. */
  async function copy(from: Side, to: Side) {
    const names = [...from.sel];
    if (!names.length) return toast("Выделите, что копировать", "err");
    if (isLocal(from) && isLocal(to)) return toast("Обе панели — эта машина: файлы копируются в IDE или проводнике", "err");
    const paths = names.map((n) => joinPath(from.path, n));
    to.status.textContent = `копирую ${names.length}…`;
    try {
      const n = isLocal(from)
        ? await invoke<number>("sftp_put", { target: to.target, local: paths, remoteDir: to.path })
        : isLocal(to)
          ? await invoke<number>("sftp_get", { target: from.target, remote: paths, localDir: to.path })
          : await invoke<number>("sftp_between", { fromTarget: from.target, paths, toTarget: to.target, toDir: to.path });
      toast(`Скопировано: ${n}`);
      // перенесённое выделено в панели-приёмнике: сразу видно, что приехало и куда
      await load(to, names);
    } catch (e) {
      toast(String(e), "err");
      await load(to);
    }
  }

  // ----- перетаскивание между панелями -----
  // Указательные события, а не HTML5 drag-and-drop: в webview он ведёт себя непредсказуемо
  // (так же сделано перетаскивание вкладок терминала и карточек мониторинга).
  function wireDrag(from: Side, to: Side) {
    let start: { x: number; y: number; name: string } | null = null;
    let ghost: HTMLElement | null = null;

    const overTarget = (e: PointerEvent) => !!document.elementFromPoint(e.clientX, e.clientY)?.closest(".fx2-pane") &&
      document.elementFromPoint(e.clientX, e.clientY)!.closest(".fx2-pane") === to.el;

    const stop = () => {
      ghost?.remove();
      ghost = null;
      start = null;
      to.el.classList.remove("drop");
    };

    from.body.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
      const tr = (e.target as HTMLElement).closest<HTMLElement>("tr[data-name]");
      if (!tr || tr.dataset.name === "..") return;
      start = { x: e.clientX, y: e.clientY, name: tr.dataset.name! };
    });

    from.body.addEventListener("pointermove", (e) => {
      if (!start) return;
      if (!ghost) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 6) return;
        // тащим выделенное; если тащат невыделенную строку — выделяем только её
        if (!from.sel.has(start.name)) { from.sel.clear(); from.sel.add(start.name); syncSel(from); }
        ghost = document.createElement("div");
        ghost.className = "fx2-ghost";
        ghost.textContent = from.sel.size === 1 ? start.name : `${from.sel.size} ${t("объектов")}`;
        document.body.appendChild(ghost);
        from.body.setPointerCapture(e.pointerId);
      }
      ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
      to.el.classList.toggle("drop", overTarget(e));
    });

    from.body.addEventListener("pointerup", (e) => {
      const drop = !!ghost && overTarget(e);
      if (ghost) from.body.releasePointerCapture(e.pointerId);
      stop();
      if (drop) copy(from, to);
    });
    from.body.addEventListener("pointercancel", stop);
  }

  wire(sides.a);
  wire(sides.b);
  wireDrag(sides.a, sides.b);
  wireDrag(sides.b, sides.a);
  root.querySelector<HTMLElement>("[data-a=to-b]")!.onclick = () => copy(sides.a, sides.b);
  root.querySelector<HTMLElement>("[data-a=to-a]")!.onclick = () => copy(sides.b, sides.a);

  fillHosts().then(() => { load(sides.a); load(sides.b); });
}
