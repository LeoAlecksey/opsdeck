import { helpBtn } from "./help";
import { icon } from "./icons";
import { invoke } from "@tauri-apps/api/core";
import { kpEntries, kpStatus, pickEntry } from "./keepass";
import { registerProvider } from "./palette";
import { ask, esc, toast } from "./ui";

type SshHost = {
  id: string; name: string; group: string; host: string; port: number; user: string;
  identity_file: string; jump: string; auth: string; keepass_entry: string;
};
type Effective = { user: string; hostname: string; port: string; identity_files: string[]; proxy_jump: string; proxy_command?: string };
type ConfigHost = { alias: string; group: string; hostname: string; user: string; port: string; identity_file: string; proxy_jump: string; proxy_command?: string; effective?: Effective };
type SshList = { hosts: SshHost[]; config: ConfigHost[] };
type Spec = { program: string; args: string[]; password_copied: boolean };

const AUTH: Record<string, string> = { key: "ключ / ssh-agent", keepass: "пароль из KeePass", password: "пароль (keyring)", none: "спросит ssh" };

async function connect(title: string, target: { id?: string; alias?: string }) {
  try {
    const spec = await invoke<Spec>("ssh_connect", { id: target.id ?? null, alias: target.alias ?? null });
    window.dispatchEvent(new CustomEvent("open-terminal", { detail: { title, program: spec.program, args: spec.args, keepOpen: true } }));
    if (spec.password_copied) toast("Пароль в буфере на 30 с — вставьте Ctrl+Shift+V");
  } catch (e) { toast(String(e), "err"); }
}

registerProvider(async () => {
  const l = await invoke<SshList>("ssh_list");
  return [
    ...l.hosts.map((h) => ({ group: "SSH", title: `SSH: ${h.name}`, hint: `${h.group ? h.group + " · " : ""}${h.user ? h.user + "@" : ""}${h.host}`, run: () => connect(`ssh ${h.name}`, { id: h.id }) })),
    ...l.config.map((h) => ({ group: "SSH", title: `SSH: ${h.alias}`, hint: `${h.group ? h.group + " · " : ""}~/.ssh/config${h.hostname ? " · " + h.hostname : ""}`, run: () => connect(`ssh ${h.alias}`, { alias: h.alias }) })),
  ];
});

export function mountSsh(root: HTMLElement) {
  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <h2>SSH</h2>
        <div class="row"><input class="ssh-filter" placeholder="фильтр…" spellcheck="false" /><button class="primary" data-a="add">${icon("plus", 16)} Хост</button>${helpBtn("ssh")}</div>
      </div>
      <p class="muted">Подключение открывает вкладку терминала. Хосты из ~/.ssh/config подключаются по алиасу со всеми его настройками. Пароль из KeePass/keyring кладётся в буфер на 30 с.</p>
      <div class="ssh-list"></div>
      <dialog class="ssh-dialog">
        <form method="dialog">
          <h3>SSH-хост</h3>
          <div class="grid2">
            <label>Название <input name="name" required placeholder="prod-db-1" /></label>
            <label>Группа <input name="group" list="ssh-groups" placeholder="prod / стенд" /></label>
            <label>Адрес <input name="host" required placeholder="10.0.0.5 или host.example.com" spellcheck="false" /></label>
            <div class="grid2">
              <label>Порт <input name="port" type="number" min="1" max="65535" value="22" /></label>
              <label>Пользователь <input name="user" spellcheck="false" autocomplete="off" /></label>
            </div>
          </div>
          <label>Ключ (-i) <input name="identity_file" list="ssh-keys" spellcheck="false" placeholder="по умолчанию: ssh-agent / ~/.ssh/id_*" /></label>
          <label>Jump-хост (-J) <input name="jump" spellcheck="false" placeholder="user@bastion:22" /></label>
          <label>Аутентификация <select name="auth">${Object.entries(AUTH).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
          <div data-s="keepass" class="kp-bind"><span class="kp-bound muted">запись не выбрана</span><button type="button" data-a="pick">Выбрать запись…</button></div>
          <label data-s="password">Пароль <input name="secret" type="password" autocomplete="new-password" /></label>
          <datalist id="ssh-keys"></datalist><datalist id="ssh-groups"></datalist>
          <p class="err form-err"></p>
          <div class="actions"><button value="cancel" formnovalidate>Отмена</button><button value="save" class="primary">Сохранить</button></div>
        </form>
      </dialog>
    </div>`;

  const list = root.querySelector<HTMLElement>(".ssh-list")!;
  const filter = root.querySelector<HTMLInputElement>(".ssh-filter")!;
  const dialog = root.querySelector<HTMLDialogElement>("dialog")!;
  const form = dialog.querySelector("form")!;
  const f = (n: string) => form.elements.namedItem(n) as HTMLInputElement & HTMLSelectElement;
  let data: SshList = { hosts: [], config: [] };
  let editing: SshHost | null = null;
  let boundEntry = "";
  let titles = new Map<string, string>();
  let localUser = "";
  invoke<string>("ssh_local_user").then((u) => (localUser = u)).catch(() => {});

  const sync = () => {
    const a = f("auth").value;
    form.querySelector<HTMLElement>("[data-s=keepass]")!.hidden = a !== "keepass";
    form.querySelector<HTMLElement>("[data-s=password]")!.hidden = a !== "password";
    f("user").placeholder = a === "keepass" ? "из записи KeePass" : "";
    f("secret").placeholder = editing ? "оставьте пустым, чтобы не менять" : "";
  };
  f("auth").onchange = sync;
  const setBound = (id: string, label?: string) => {
    boundEntry = id;
    form.querySelector(".kp-bound")!.textContent = id ? (label ?? titles.get(id) ?? "запись выбрана") : "запись не выбрана";
  };
  form.querySelector<HTMLElement>("[data-a=pick]")!.onclick = async () => {
    const e = await pickEntry();
    if (e) setBound(e.id, `${e.title}${e.username ? " · " + e.username : ""}`);
  };

  async function open(h: Partial<SshHost> | null, isEdit = false) {
    editing = isEdit ? (h as SshHost) : null;
    form.reset();
    form.querySelector(".form-err")!.textContent = "";
    for (const k of ["name", "group", "host", "user", "identity_file", "jump"] as const) f(k).value = String(h?.[k] ?? "");
    f("port").value = String(h?.port ?? 22);
    f("auth").value = h?.auth ?? "key";
    setBound(h?.keepass_entry ?? "");
    sync();
    form.querySelector("#ssh-groups")!.innerHTML = allGroups().map((g) => `<option value="${esc(g)}">`).join("");
    const keys = await invoke<string[]>("ssh_keys").catch(() => []);
    form.querySelector("#ssh-keys")!.innerHTML = keys.map((k) => `<option value="${esc(k)}">`).join("");
    dialog.showModal();
  }

  form.addEventListener("submit", async (e) => {
    if ((e.submitter as HTMLButtonElement | null)?.value !== "save") return;
    e.preventDefault();
    const host: SshHost = {
      id: editing?.id ?? crypto.randomUUID(),
      name: f("name").value.trim(), group: f("group").value.trim(), host: f("host").value.trim(),
      port: Number(f("port").value) || 22, user: f("user").value.trim(), identity_file: f("identity_file").value.trim(),
      jump: f("jump").value.trim(), auth: f("auth").value, keepass_entry: f("auth").value === "keepass" ? boundEntry : "",
    };
    try {
      await invoke("ssh_save", { host, secret: f("secret").value || null });
      dialog.close();
      load();
    } catch (err) { form.querySelector(".form-err")!.textContent = String(err); }
  });

  async function load() {
    data = await invoke<SshList>("ssh_list").catch((e) => { toast(String(e), "err"); return { hosts: [], config: [] }; });
    titles = new Map();
    if (data.hosts.some((h) => h.auth === "keepass") && (await kpStatus()).unlocked)
      (await kpEntries().catch(() => [])).forEach((e) => titles.set(e.id, e.title));
    draw();
  }

  // collapsed groups survive restarts (per viewer, like the web panel rows)
  const closed = new Set<string>((() => { try { return JSON.parse(localStorage.getItem("opsdeck.ssh.closed") ?? "[]"); } catch { return []; } })());
  const saveClosed = () => { try { localStorage.setItem("opsdeck.ssh.closed", JSON.stringify([...closed])); } catch { /* ignore */ } };
  const CFG = "~/.ssh/config";
  const allGroups = () => [...new Set([...data.hosts.map((h) => h.group), ...data.config.map((h) => h.group)].filter(Boolean))].sort((a, b) => a.localeCompare(b));

  const ownRow = (h: SshHost) => `
        <tr data-id="${esc(h.id)}">
          <td class="mt-name">${esc(h.name)}</td>
          <td class="mono">${esc(h.user ? h.user + "@" : "")}${esc(h.host)}${h.port !== 22 ? `<span class="muted">:${h.port}</span>` : ""}</td>
          <td class="muted">${h.jump ? `через ${esc(h.jump)} · ` : ""}${h.auth === "keepass" ? `${icon("key", 14)} ${esc(titles.get(h.keepass_entry) ?? "KeePass")}` : esc(AUTH[h.auth] ?? "")}</td>
          <td class="mt-acts">
            <button class="primary" data-a="connect">Подключиться</button>
            <button class="icon" data-a="edit" title="Изменить (в т.ч. группу)">${icon("edit", 14)}</button>
            <button class="icon danger" data-a="del" title="Удалить">${icon("trash", 14)}</button>
          </td></tr>`;

  // what ssh will really use (`ssh -G`), including Match/Include/wildcard blocks
  const cfgRow = (h: ConfigHost) => {
    const e = h.effective;
    const user = e?.user || h.user, host = e?.hostname || h.hostname || h.alias, port = e?.port && e.port !== "22" ? e.port : "";
    const key = h.identity_file || (e && e.identity_files.length === 1 ? e.identity_files[0] : "");
    // no User anywhere for this host → ssh logs in as the local user, usually not what was meant
    const suspicious = !!e && !h.user && !!localUser && e.user === localUser;
    const warn = suspicious ? `<span class="ssh-warn" title="ssh подключится как «${esc(localUser)}»: для этого хоста не сработал ни один User. Если он задан в блоке «Match Host …» — замените на «Match originalhost …»: Match Host сравнивает уже подставленный HostName (IP), а не алиас.">⚠ пользователь ${esc(localUser)}?</span>` : "";
    const proxy = (e?.proxy_jump || h.proxy_jump) ? ` через ${esc(e?.proxy_jump || h.proxy_jump)} · ` : (e?.proxy_command || h.proxy_command) ? ` через proxy · ` : "";
    return `<tr data-alias="${esc(h.alias)}">
          <td class="mt-name">${esc(h.alias)} <span class="ssh-src" title="из ~/.ssh/config">cfg</span></td>
          <td class="mono">${esc(user ? user + "@" : "")}${esc(host)}${port ? `<span class="muted">:${esc(port)}</span>` : ""}</td>
          <td class="muted">${warn}${proxy}${key ? ` ключ ${esc(key.split("/").pop())}` : ""}</td>
          <td class="mt-acts">
            <button class="primary" data-a="connect-cfg">Подключиться</button>
            <button class="icon" data-a="group-cfg" title="Группа">${icon("folder", 14)}</button>
            <button class="icon" data-a="copy-cfg" title="Сохранить как профиль OpsDeck (можно привязать пароль из KeePass)">⧉</button>
          </td></tr>`;
  };

  function draw() {
    const q = filter.value.trim().toLowerCase();
    const match = (...xs: string[]) => !q || xs.join(" ").toLowerCase().includes(q);
    const own = data.hosts.filter((h) => match(h.name, h.host, h.group, h.user)).sort((a, b) => a.name.localeCompare(b.name));
    const cfg = data.config.filter((h) => match(h.alias, h.group, h.hostname, h.user, h.effective?.hostname ?? "", h.effective?.user ?? ""));
    // one row per group; own profiles without a group first, ungrouped ~/.ssh/config hosts last
    const groups = new Map<string, string[]>();
    const add = (g: string, html: string) => groups.set(g, [...(groups.get(g) ?? []), html]);
    own.forEach((h) => add(h.group, ownRow(h)));
    cfg.forEach((h) => add(h.group || CFG, cfgRow(h)));
    const order = [...groups.keys()].sort((a, b) =>
      a === "" ? -1 : b === "" ? 1 : a === CFG ? 1 : b === CFG ? -1 : a.localeCompare(b));
    list.innerHTML = order.map((g) => `
      <details class="ssh-group" data-g="${esc(g)}" ${q || !closed.has(g) ? "open" : ""}>
        <summary><span class="ssh-group-title">${esc(g || "Без группы")}</span><span class="conn-row-count">${groups.get(g)!.length}</span>
          ${g && g !== CFG ? `<button class="icon ssh-group-ren" data-a="rename" title="Переименовать группу">${icon("edit", 14)}</button>` : ""}</summary>
        <table class="res mt-table"><tbody>${groups.get(g)!.join("")}</tbody></table>
      </details>`).join("")
      || (q ? `<p class="muted">Ничего не найдено.</p>` : `<p class="muted">Пока пусто — добавьте хост или заведите его в ~/.ssh/config.</p>`);
    list.querySelectorAll<HTMLDetailsElement>("details").forEach((d) => d.addEventListener("toggle", () => {
      if (q) return; // filtering opens everything; don't remember that
      d.open ? closed.delete(d.dataset.g!) : closed.add(d.dataset.g!);
      saveClosed();
    }));
  }

  list.onclick = async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
    if (b?.dataset.a === "rename") {
      e.preventDefault(); // don't toggle the group
      const from = b.closest<HTMLElement>("details")!.dataset.g!;
      const to = await ask("Переименовать группу", `Новое имя для «${from}» (пусто — разгруппировать):`, { input: from, ok: "Переименовать" });
      if (to === null || to === from) return;
      await invoke("ssh_group_rename", { from, to }).catch((err) => toast(String(err), "err"));
      if (closed.delete(from) && to) closed.add(to);
      saveClosed();
      return load();
    }
    const tr = b?.closest("tr");
    if (!b || !tr) return;
    const h = data.hosts.find((x) => x.id === tr.dataset.id);
    const c = data.config.find((x) => x.alias === tr.dataset.alias);
    switch (b.dataset.a) {
      case "connect": if (h) connect(`ssh ${h.name}`, { id: h.id }); break;
      case "connect-cfg": if (c) connect(`ssh ${c.alias}`, { alias: c.alias }); break;
      case "edit": if (h) open(h, true); break;
      case "group-cfg":
        if (c) {
          const known = allGroups();
          const g = await ask("Группа", `Группа для «${c.alias}»${known.length ? ` (есть: ${known.join(", ")})` : ""}. Пусто — без группы.`,
            { input: c.group, placeholder: "prod / стенд", ok: "Сохранить" });
          if (g === null) return;
          await invoke("ssh_config_group", { alias: c.alias, group: g }).catch((err) => toast(String(err), "err"));
          load();
        }
        break;
      case "copy-cfg":
        if (c) open({ name: c.alias, host: c.hostname || c.alias, user: c.user, port: Number(c.port) || 22,
          identity_file: c.identity_file, jump: c.proxy_jump, auth: "key", group: c.group }); // ssh -i expands ~ itself
        break;
      case "del":
        if (h && (await ask("Удалить хост", `Удалить «${h.name}» (${h.host})?`, { ok: "Удалить", danger: true })) !== null) {
          await invoke("ssh_delete", { id: h.id });
          load();
        }
    }
  };
  // ----- drag a host onto another group (pointer events: HTML5 DnD is unreliable in the webview) -----
  async function setGroup(row: HTMLElement, group: string) {
    const h = data.hosts.find((x) => x.id === row.dataset.id);
    const c = data.config.find((x) => x.alias === row.dataset.alias);
    try {
      if (h && h.group !== group) await invoke("ssh_save", { host: { ...h, group }, secret: null });
      else if (c && c.group !== group) await invoke("ssh_config_group", { alias: c.alias, group });
      else return;
      if (group) { closed.delete(group); saveClosed(); }
      toast(group ? `Перемещено в «${group}»` : "Перемещено: без группы");
      load();
    } catch (err) { toast(String(err), "err"); }
  }

  let dragJustEnded = false;
  list.addEventListener("click", (e) => { if (dragJustEnded) { e.stopPropagation(); e.preventDefault(); } }, true);
  list.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>("tr[data-id], tr[data-alias]");
    if (!row || e.button !== 0 || t.closest("button, input, a")) return;
    const x0 = e.clientX, y0 = e.clientY;
    const noSelect = (ev: Event) => ev.preventDefault();
    const from = row.closest<HTMLElement>("details")?.dataset.g ?? "";
    let ghost: HTMLElement | null = null, zone: HTMLElement | null = null, target: string | null = null;
    const mark = (el: Element | null) => {
      list.querySelectorAll(".drop-target").forEach((x) => x.classList.remove("drop-target"));
      el?.classList.add("drop-target");
    };
    const move = (ev: PointerEvent) => {
      if (!ghost) {
        // inside the row the mouse selects text as usual; leaving the row picks the host up
        const r = row.getBoundingClientRect();
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6 || (ev.clientY >= r.top && ev.clientY <= r.bottom)) return;
        window.getSelection()?.removeAllRanges();
        document.body.classList.add("no-select");
        document.addEventListener("selectstart", noSelect);
        ghost = document.createElement("div");
        ghost.className = "drag-ghost";
        ghost.textContent = row.querySelector(".mt-name")?.childNodes[0]?.textContent?.trim() ?? "";
        document.body.appendChild(ghost);
        zone = document.createElement("div");
        zone.className = "ssh-new-group";
        zone.textContent = "+ Новая группа";
        list.appendChild(zone);
        row.classList.add("dragging");
      }
      ghost.style.left = `${ev.clientX + 12}px`;
      ghost.style.top = `${ev.clientY + 8}px`;
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const det = el?.closest<HTMLElement>("details.ssh-group");
      if (el && zone && zone.contains(el)) { target = "\u0001new"; mark(zone); return; }
      if (!det) { target = null; mark(null); return; }
      // "~/.ssh/config" and "Без группы" both mean: no group
      const g = det.dataset.g === CFG ? "" : det.dataset.g ?? "";
      target = det.dataset.g === from ? null : g;
      mark(target === null ? null : det.querySelector("summary"));
    };
    const up = async () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!ghost) return;
      document.body.classList.remove("no-select");
      document.removeEventListener("selectstart", noSelect);
      window.getSelection()?.removeAllRanges();
      ghost.remove();
      zone?.remove();
      row.classList.remove("dragging");
      mark(null);
      dragJustEnded = true;
      setTimeout(() => { dragJustEnded = false; }, 0);
      if (target === null) return;
      if (target === "\u0001new") {
        const name = (await ask("Новая группа", "Имя группы:", { input: "", placeholder: "prod / стенд", ok: "Создать" }))?.trim();
        if (!name) return;
        target = name;
      }
      setGroup(row, target);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  filter.oninput = draw;
  root.querySelector<HTMLElement>("[data-a=add]")!.onclick = () => open(null);
  // defer until the tab is shown — mounting all views at startup would run N× ssh -G (console flash on Windows)
  window.addEventListener("view-shown", (e) => { if ((e as CustomEvent).detail === "ssh") load(); });
}
