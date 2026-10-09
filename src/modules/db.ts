import { helpBtn } from "./help";
import { icon } from "./icons";
import { invoke } from "@tauri-apps/api/core";
import { kpEntries, kpStatus, pickEntry } from "./keepass";
import { ask, esc, toast } from "./ui";
import { registerProvider } from "./palette";
import { targets } from "./monitor";

type Profile = {
  id: string; name: string; group: string; engine: string; host: string; port: number; database: string;
  username: string; auth: string; keepass_entry: string; tls: string; readonly: boolean; options: string; jump?: string;
};
type DbNode = { name: string; kind: string; detail: string; leaf: boolean; query: string | null };
type Result = {
  columns: string[]; rows: (string | null)[][]; affected: number | null; truncated: boolean;
  elapsed_ms: number; message: string; docs: unknown[] | null;
};

const ENGINES: Record<string, { label: string; short: string; port: number; tlsPort?: number; db: string; dbHint: string; sample: string }> = {
  postgres: { label: "PostgreSQL", short: "PG", port: 5432, db: "База", dbHint: "postgres", sample: "SELECT now();" },
  mysql: { label: "MySQL / MariaDB", short: "My", port: 3306, db: "База по умолчанию", dbHint: "необязательно", sample: "SHOW DATABASES;" },
  clickhouse: { label: "ClickHouse (HTTP)", short: "CH", port: 8123, tlsPort: 8443, db: "База по умолчанию", dbHint: "default", sample: "SELECT version();" },
  redis: { label: "Redis", short: "R", port: 6379, db: "Номер базы", dbHint: "0", sample: "INFO server" },
  mongodb: { label: "MongoDB", short: "M", port: 27017, db: "База по умолчанию", dbHint: "admin", sample: "show dbs" },
};
const AUTH: Record<string, string> = { password: "пароль (keyring)", keepass: "из KeePass", none: "без пароля" };
const TLS: Record<string, string> = { off: "без TLS", require: "TLS, сертификат не проверять", verify: "TLS с проверкой сертификата" };
const KIND_ICON: Record<string, string> = {
  database: icon("db", 14), schema: "▤", table: "▦", view: "◫", column: "·", index: icon("zap", 14), key: icon("key", 14), collection: "▦", field: "·", info: "ℹ",
};

const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export function mountDb(root: HTMLElement) {
  root.classList.add("dbv");
  root.innerHTML = `
    <aside class="db-side">
      <div class="side-head"><span>Базы данных</span>
        <span class="row"><button class="icon" data-a="add" title="Новое подключение">${icon("plus", 16)}</button>${helpBtn("db")}</span></div>
      <input class="db-filter" placeholder="фильтр…" spellcheck="false" />
      <div class="db-tree"></div>
    </aside>
    <div class="db-main">
      <div class="db-bar">
        <strong class="db-title muted">выберите подключение слева</strong>
        <span class="db-ro" hidden title="Подключение только для чтения: запись блокируется">только чтение</span>
        <label class="db-ctx-l" title="База (для Redis — номер db), в которой выполняется запрос">в <input class="db-ctx" list="db-ctx-list" spellcheck="false" placeholder="по умолчанию" /></label>
        <datalist id="db-ctx-list"></datalist>
        <span class="spacer"></span>
        <select class="db-hist" title="История запросов этого подключения"><option value="">История…</option></select>
        <button class="primary" data-a="run" disabled title="Выполнить (Ctrl+Enter). Если есть выделение — только его">${icon("play", 16)} Выполнить</button>
      </div>
      <textarea class="db-editor" spellcheck="false" placeholder="Запрос… Ctrl+Enter — выполнить (выделенное или всё)" disabled></textarea>
      <div class="db-hsplit" title="Потяните, чтобы изменить высоту"></div>
      <div class="db-res">
        <div class="db-status muted"></div>
        <div class="db-res-tools" hidden>
          <div class="seg db-view" hidden><button data-v="table" class="active">Таблица</button><button data-v="json">JSON</button></div>
          <button class="ghost" data-a="csv" title="Скопировать результат как CSV">CSV</button>
          <button class="ghost" data-a="json" title="Скопировать результат как JSON">JSON</button>
        </div>
        <div class="db-table-wrap"></div>
      </div>
    </div>
    <dialog class="db-dialog">
      <form method="dialog">
        <h3>Подключение к базе</h3>
        <div class="grid2">
          <label>Название <input name="name" required placeholder="prod-orders" /></label>
          <label>Группа <input name="group" placeholder="prod / stage" /></label>
          <label>Тип <select name="engine">${Object.entries(ENGINES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}</select></label>
          <div class="grid2">
            <label>Адрес <input name="host" required placeholder="10.0.0.5" spellcheck="false" /></label>
            <label>Порт <input name="port" type="number" min="1" max="65535" required /></label>
          </div>
          <label data-s="db"><span class="db-label">База</span> <input name="database" spellcheck="false" /></label>
          <label style="grid-column: 1 / -1" title="База видна только с бастиона: OpsDeck поднимет туннель ssh -L через выбранный хост (вход по ключу, как в мониторинге). Хосты — из профилей SSH и ~/.ssh/config">Через SSH-хост (jump) <select name="jump"><option value="">напрямую</option></select></label>
          <label>Шифрование <select name="tls">${Object.entries(TLS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
        </div>
        <label data-s="options">Доп. параметры URI (MongoDB) <input name="options" spellcheck="false" placeholder="authSource=admin&replicaSet=rs0" /></label>
        <label>Учётные данные <select name="auth">${Object.entries(AUTH).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
        <div data-s="keepass" class="kp-bind"><span class="kp-bound muted">запись не выбрана</span><button type="button" data-a="pick">Выбрать запись…</button></div>
        <div class="grid2">
          <label data-s="user">Пользователь <input name="username" autocomplete="off" spellcheck="false" /></label>
          <label data-s="password">Пароль <input name="secret" type="password" autocomplete="new-password" /></label>
        </div>
        <label class="check"><input type="checkbox" name="readonly" /> Только чтение (для прода): запросы на запись не выполняются</label>
        <p class="muted hint ro-hint"></p>
        <p class="err form-err"></p>
        <p class="ok form-ok"></p>
        <div class="actions">
          <button value="cancel" formnovalidate>Отмена</button>
          <button value="test">Сохранить и проверить</button>
          <button value="save" class="primary">Сохранить</button>
        </div>
      </form>
    </dialog>`;

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const treeEl = $(".db-tree"), filter = $<HTMLInputElement>(".db-filter");
  const editor = $<HTMLTextAreaElement>(".db-editor"), runBtn = $<HTMLButtonElement>("[data-a=run]");
  const ctxIn = $<HTMLInputElement>(".db-ctx"), hist = $<HTMLSelectElement>(".db-hist");
  const statusEl = $(".db-status"), tableWrap = $(".db-table-wrap"), tools = $(".db-res-tools");
  const dialog = $<HTMLDialogElement>(".db-dialog"), form = dialog.querySelector("form")!;
  const f = (n: string) => form.elements.namedItem(n) as HTMLInputElement & HTMLSelectElement;

  let profiles: Profile[] = [];
  let active: Profile | null = null;
  let editing: Profile | null = null;
  let boundEntry = "";
  let titles = new Map<string, string>();
  let last: Result | null = null;
  let view: "table" | "json" = "table";
  let running = false;
  const openNodes = new Set<string>(JSON.parse(ls.get("opsdeck.db.open") ?? "[]") as string[]);
  const saveOpen = () => ls.set("opsdeck.db.open", JSON.stringify([...openNodes]));
  const cache = new Map<string, DbNode[]>();

  // ----- connection dialog -----
  const syncForm = () => {
    const e = ENGINES[f("engine").value];
    const a = f("auth").value;
    form.querySelector(".db-label")!.textContent = e.db;
    f("database").placeholder = e.dbHint;
    form.querySelector<HTMLElement>("[data-s=options]")!.hidden = f("engine").value !== "mongodb";
    form.querySelector<HTMLElement>("[data-s=keepass]")!.hidden = a !== "keepass";
    form.querySelector<HTMLElement>("[data-s=password]")!.hidden = a !== "password";
    f("username").placeholder = a === "keepass" ? "из записи KeePass" : ({ postgres: "postgres", mysql: "root", clickhouse: "default", redis: "(ACL, необязательно)", mongodb: "" } as Record<string, string>)[f("engine").value];
    f("secret").placeholder = editing ? "оставьте пустым, чтобы не менять" : "";
    form.querySelector(".ro-hint")!.textContent = ({
      postgres: "PostgreSQL сам запрещает запись (default_transaction_read_only).",
      clickhouse: "ClickHouse сам запрещает запись (readonly=2).",
      mysql: "MySQL: сессия READ ONLY + выполняются только SELECT / SHOW / DESCRIBE / EXPLAIN.",
      redis: "Redis: выполняются только читающие команды (GET, HGETALL, SCAN, INFO…).",
      mongodb: "MongoDB: только find / aggregate без $out/$merge / count / distinct и читающие команды.",
    } as Record<string, string>)[f("engine").value];
  };
  let lastEngine = "";
  f("engine").onchange = () => {
    // swap the port only if it still is the previous engine's default
    const prev = ENGINES[lastEngine], next = ENGINES[f("engine").value];
    const cur = Number(f("port").value);
    if (!cur || (prev && (cur === prev.port || cur === prev.tlsPort))) f("port").value = String(f("tls").value !== "off" && next.tlsPort ? next.tlsPort : next.port);
    lastEngine = f("engine").value;
    syncForm();
  };
  f("tls").onchange = () => {
    const e = ENGINES[f("engine").value];
    if (e.tlsPort && [e.port, e.tlsPort].includes(Number(f("port").value))) f("port").value = String(f("tls").value !== "off" ? e.tlsPort : e.port);
  };
  f("auth").onchange = syncForm;
  const setBound = (id: string, label?: string) => {
    boundEntry = id;
    form.querySelector(".kp-bound")!.textContent = id ? (label ?? titles.get(id) ?? "запись выбрана") : "запись не выбрана";
  };
  form.querySelector<HTMLElement>("[data-a=pick]")!.onclick = async () => {
    const e = await pickEntry();
    if (e) setBound(e.id, `${e.title}${e.username ? " · " + e.username : ""}`);
  };

  /** The jump-host choices: SSH profiles and ~/.ssh/config hosts (a host that has since been removed stays selectable). */
  async function fillJump(current: string) {
    const list = await invoke<Parameters<typeof targets>[0]>("ssh_list").catch(() => ({ hosts: [], config: [] }));
    const all = targets(list);
    const opts = [`<option value="">напрямую</option>`, ...all.map((t) => `<option value="${esc(t.key)}">${esc(t.name)} — ${esc(t.addr)}</option>`)];
    if (current && !all.some((t) => t.key === current)) opts.push(`<option value="${esc(current)}">${esc(current)} (не найден)</option>`);
    f("jump").innerHTML = opts.join("");
    f("jump").value = current;
  }

  function openDialog(p: Profile | null) {
    editing = p;
    form.reset();
    form.querySelector(".form-err")!.textContent = "";
    form.querySelector(".form-ok")!.textContent = "";
    for (const k of ["name", "group", "host", "database", "username", "options"] as const) f(k).value = p?.[k] ?? "";
    f("engine").value = p?.engine ?? "postgres";
    lastEngine = f("engine").value;
    f("port").value = String(p?.port ?? ENGINES[f("engine").value].port);
    f("tls").value = p?.tls ?? "off";
    f("auth").value = p?.auth ?? "password";
    f("readonly").checked = p?.readonly ?? false;
    setBound(p?.keepass_entry ?? "");
    syncForm();
    fillJump(p?.jump ?? "");
    dialog.showModal();
  }

  form.addEventListener("submit", async (e) => {
    const action = (e.submitter as HTMLButtonElement | null)?.value;
    if (action !== "save" && action !== "test") return;
    e.preventDefault();
    const auth = f("auth").value;
    const profile: Profile = {
      id: editing?.id ?? crypto.randomUUID(),
      name: f("name").value.trim(), group: f("group").value.trim(), engine: f("engine").value,
      host: f("host").value.trim(), port: Number(f("port").value) || ENGINES[f("engine").value].port,
      database: f("database").value.trim(), username: f("username").value.trim(), auth,
      keepass_entry: auth === "keepass" ? boundEntry : "", tls: f("tls").value, readonly: f("readonly").checked,
      options: f("engine").value === "mongodb" ? f("options").value.trim() : "",
      jump: f("jump").value,
    };
    const errEl = form.querySelector(".form-err")!, okEl = form.querySelector(".form-ok")!;
    errEl.textContent = okEl.textContent = "";
    try {
      await invoke("db_save", { profile, secret: f("secret").value || null });
      editing = profile;
      f("secret").value = "";
      for (const k of [...cache.keys()]) if (k.startsWith(profile.id)) cache.delete(k);
      await load();
      if (action === "save") { dialog.close(); return; }
      okEl.textContent = "проверяю…";
      const v = await invoke<string>("db_test", { id: profile.id });
      okEl.textContent = `✓ ${v}`;
    } catch (err) { okEl.textContent = ""; errEl.textContent = String(err); }
  });

  // ----- list + structure tree -----
  async function load() {
    profiles = await invoke<Profile[]>("db_list").catch((e) => { toast(String(e), "err"); return []; });
    titles = new Map();
    if ((await kpStatus()).unlocked) (await kpEntries().catch(() => [])).forEach((e) => titles.set(e.id, `${e.title}${e.username ? " · " + e.username : ""}`));
    if (active) active = profiles.find((p) => p.id === active!.id) ?? null;
    drawTree();
  }

  const key = (id: string, path: string[]) => [id, ...path].join("\u0001");

  function nodeHtml(p: Profile, path: string[], n: DbNode, depth: number): string {
    const full = [...path, n.name];
    const k = key(p.id, full);
    const open = !n.leaf && openNodes.has(k);
    const kids = open ? childrenHtml(p, full, depth + 1) : "";
    const attrs = `data-id="${esc(p.id)}" data-path="${esc(JSON.stringify(full))}" data-kind="${esc(n.kind)}"${n.query ? ` data-q="${esc(n.query)}"` : ""}`;
    if (n.leaf) {
      return `<div class="db-leaf" style="--depth:${depth}" ${attrs} title="${esc(n.query ? "Двойной клик — выполнить: " + n.query : `${n.name} ${n.detail}`)}">
        <span class="tree-icon">${KIND_ICON[n.kind] ?? "·"}</span><span class="tree-label">${esc(n.name)}</span><span class="db-detail">${esc(n.detail)}</span></div>`;
    }
    return `<div class="tree-dir ${open ? "open" : ""}" ${attrs}>
      <button class="tree-row" style="--depth:${depth}" title="${esc(n.query ? "Двойной клик — " + n.query : n.name)}"><span class="tree-caret">▸</span><span class="tree-icon">${KIND_ICON[n.kind] ?? "▸"}</span>
        <span class="tree-label">${esc(n.name)}</span><span class="db-detail">${esc(n.detail)}</span></button>
      <div class="tree-children" style="--guide:${depth}">${kids}</div></div>`;
  }

  function childrenHtml(p: Profile, path: string[], depth: number): string {
    const kids = cache.get(key(p.id, path));
    if (!kids) {
      // not loaded yet: fetch and redraw this branch
      fetchKids(p, path);
      return `<div class="db-leaf muted" style="--depth:${depth}">загрузка…</div>`;
    }
    return kids.length ? kids.map((n) => nodeHtml(p, path, n, depth)).join("") : `<div class="db-leaf muted" style="--depth:${depth}">пусто</div>`;
  }

  const inflight = new Set<string>();
  async function fetchKids(p: Profile, path: string[], force = false) {
    const k = key(p.id, path);
    if (inflight.has(k)) return;
    if (force) cache.delete(k);
    inflight.add(k);
    try {
      const kids = await invoke<DbNode[]>("db_tree", { id: p.id, path });
      cache.set(k, kids);
      if (path.length === 0 && active?.id === p.id) fillCtx(kids);
    } catch (e) {
      cache.set(k, [{ name: String(e), kind: "info", detail: "", leaf: true, query: null }]);
    } finally {
      inflight.delete(k);
    }
    redrawBranch(p, path);
  }

  function redrawBranch(p: Profile, path: string[]) {
    const host = path.length === 0
      ? treeEl.querySelector<HTMLElement>(`.db-conn[data-id="${CSS.escape(p.id)}"] > .tree-children`)
      : [...treeEl.querySelectorAll<HTMLElement>(`.tree-dir[data-id="${CSS.escape(p.id)}"]`)].find((d) => d.dataset.path === JSON.stringify(path))?.querySelector<HTMLElement>(":scope > .tree-children");
    if (host && host.parentElement?.classList.contains("open")) host.innerHTML = childrenHtml(p, path, path.length + 1);
  }

  function drawTree() {
    const q = filter.value.trim().toLowerCase();
    const shown = profiles.filter((p) => !q || `${p.name} ${p.group} ${p.host} ${p.engine}`.toLowerCase().includes(q));
    if (!profiles.length) {
      treeEl.innerHTML = `<p class="muted pad">Подключений пока нет. Нажмите ＋, укажите адрес и порт.</p>`;
      return;
    }
    const groups = new Map<string, Profile[]>();
    for (const p of shown.sort((a, b) => a.name.localeCompare(b.name))) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
    treeEl.innerHTML = [...groups.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b))).map(([g, ps]) => `
      ${g ? `<div class="side-head small">${esc(g)}</div>` : groups.size > 1 ? `<div class="side-head small">без группы</div>` : ""}
      ${ps.map((p) => {
        const open = openNodes.has(key(p.id, []));
        return `<div class="tree-dir db-conn ${open ? "open" : ""} ${active?.id === p.id ? "active" : ""}" data-id="${esc(p.id)}" data-path="[]">
          <button class="tree-row" style="--depth:0" title="${esc(`${ENGINES[p.engine]?.label} ${p.host}:${p.port}`)}">
            <span class="tree-caret">▸</span><span class="db-eng db-eng-${esc(p.engine)}">${ENGINES[p.engine]?.short ?? "?"}</span>
            <span class="tree-label">${esc(p.name)}</span>${p.readonly ? `<span class="db-lock" title="только чтение">${icon("lock", 14)}</span>` : ""}
            <span class="db-acts"><span data-c="refresh" title="Обновить структуру">${icon("refresh", 14)}</span><span data-c="edit" title="Изменить">${icon("edit", 14)}</span><span data-c="del" title="Удалить">${icon("trash", 14)}</span></span>
          </button>
          <div class="tree-children">${open ? childrenHtml(p, [], 1) : ""}</div></div>`;
      }).join("")}`).join("");
  }

  treeEl.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const dir = t.closest<HTMLElement>(".tree-dir, .db-leaf");
    if (!dir?.dataset.id) return;
    const p = profiles.find((x) => x.id === dir.dataset.id);
    if (!p) return;
    const path = JSON.parse(dir.dataset.path ?? "[]") as string[];
    const act = t.closest<HTMLElement>("[data-c]")?.dataset.c;
    if (act === "edit") return openDialog(p);
    if (act === "refresh") { for (const k of [...cache.keys()]) if (k.startsWith(p.id)) cache.delete(k); openNodes.add(key(p.id, [])); saveOpen(); select(p); drawTree(); return; }
    if (act === "del") {
      if ((await ask("Удалить подключение", `Удалить «${p.name}»? Пароль из keyring тоже будет удалён.`, { ok: "Удалить", danger: true })) === null) return;
      await invoke("db_delete", { id: p.id }).catch((x) => toast(String(x), "err"));
      if (active?.id === p.id) { active = null; select(null); }
      return load();
    }
    select(p, path);
    if (dir.classList.contains("db-leaf")) return;
    const k = key(p.id, path);
    const children = dir.querySelector<HTMLElement>(":scope > .tree-children")!;
    if (dir.classList.toggle("open")) {
      openNodes.add(k);
      children.innerHTML = childrenHtml(p, path, path.length + 1);
    } else {
      openNodes.delete(k);
    }
    saveOpen();
  });
  treeEl.addEventListener("dblclick", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-q]");
    if (!el?.dataset.q) return;
    editor.value = el.dataset.q;
    saveDraft();
    run();
  });
  filter.oninput = drawTree;

  // ----- active connection, context database -----
  /** The database a tree node belongs to becomes the query context (PostgreSQL: connection db too). */
  function select(p: Profile | null, path: string[] = []) {
    const changed = active?.id !== p?.id;
    if (changed && active) saveDraft();
    active = p;
    treeEl.querySelectorAll(".db-conn").forEach((x) => x.classList.toggle("active", (x as HTMLElement).dataset.id === p?.id));
    $(".db-title").textContent = p ? `${p.name} · ${ENGINES[p.engine]?.label} ${p.host}:${p.port}` : "выберите подключение слева";
    $(".db-title").classList.toggle("muted", !p);
    $(".db-ro").hidden = !p?.readonly;
    editor.disabled = runBtn.disabled = !p;
    if (!p) return;
    if (changed) {
      editor.value = ls.get(`opsdeck.db.draft.${p.id}`) ?? ENGINES[p.engine]?.sample ?? "";
      ctxIn.value = ls.get(`opsdeck.db.ctx.${p.id}`) ?? "";
      editor.placeholder = ({
        redis: "Команды Redis, по одной в строке: GET key · HGETALL key · SCAN 0 MATCH user:* COUNT 100",
        mongodb: "db.users.find({ age: { $gt: 30 } }).sort({ name: 1 }).limit(20) · db.orders.aggregate([...]) · { serverStatus: 1 } · show collections",
      } as Record<string, string>)[p.engine] ?? "SQL… Ctrl+Enter — выполнить (выделенное или всё)";
      fillHistory();
      const top = cache.get(key(p.id, []));
      if (top) fillCtx(top);
    }
    if (path.length) {
      ctxIn.value = path[0];
      ls.set(`opsdeck.db.ctx.${p.id}`, ctxIn.value);
    }
  }
  function fillCtx(nodes: DbNode[]) {
    $("#db-ctx-list").innerHTML = nodes.filter((n) => n.kind === "database").map((n) => `<option value="${esc(n.name)}">`).join("");
  }
  ctxIn.onchange = () => active && ls.set(`opsdeck.db.ctx.${active.id}`, ctxIn.value.trim());
  const saveDraft = () => active && ls.set(`opsdeck.db.draft.${active.id}`, editor.value);
  let draftTimer = 0;
  editor.addEventListener("input", () => { clearTimeout(draftTimer); draftTimer = window.setTimeout(saveDraft, 400); });

  // ----- history -----
  const histKey = () => `opsdeck.db.history.${active?.id}`;
  const history = (): string[] => { try { return JSON.parse(ls.get(histKey()) ?? "[]"); } catch { return []; } };
  function fillHistory() {
    hist.innerHTML = `<option value="">История…</option>` + history().map((q, i) => `<option value="${i}">${esc(q.replace(/\s+/g, " ").slice(0, 90))}</option>`).join("");
  }
  hist.onchange = () => {
    const q = history()[Number(hist.value)];
    if (q !== undefined && hist.value !== "") { editor.value = q; saveDraft(); editor.focus(); }
    hist.value = "";
  };
  const remember = (q: string) => {
    ls.set(histKey(), JSON.stringify([q, ...history().filter((x) => x !== q)].slice(0, 50)));
    fillHistory();
  };

  // ----- run -----
  async function run() {
    if (!active || running) return;
    const sel = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    const q = (sel.trim() ? sel : editor.value).trim();
    if (!q) return;
    running = true;
    runBtn.disabled = true;
    runBtn.textContent = "… выполняется";
    statusEl.classList.remove("err");
    statusEl.textContent = "выполняется…";
    const p = active;
    try {
      const r = await invoke<Result>("db_query", { id: p.id, query: q, database: ctxIn.value.trim() || null });
      if (active?.id !== p.id) return;
      remember(q);
      last = r;
      showResult(r);
    } catch (e) {
      statusEl.textContent = String(e);
      statusEl.classList.add("err");
    } finally {
      running = false;
      runBtn.disabled = !active;
      runBtn.innerHTML = `${icon("play", 16)} Выполнить`;
    }
  }
  runBtn.onclick = run;
  editor.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); run(); }
    if (e.key === "Tab") { e.preventDefault(); editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end"); }
  });

  function showResult(r: Result) {
    const bits = [r.message || (r.affected !== null ? `затронуто строк: ${r.affected}` : `${r.rows.length} строк`), `${r.elapsed_ms} мс`];
    if (r.truncated) bits.push(`показаны первые ${r.rows.length}`);
    statusEl.textContent = bits.join(" · ");
    tools.hidden = !r.columns.length;
    $(".db-view").hidden = !r.docs;
    if (!r.docs) view = "table";
    root.querySelectorAll<HTMLElement>("[data-v]").forEach((b) => b.classList.toggle("active", b.dataset.v === view));
    if (!r.columns.length) { tableWrap.innerHTML = ""; return; }
    if (view === "json" && r.docs) {
      tableWrap.innerHTML = `<pre class="db-json"></pre>`;
      tableWrap.querySelector("pre")!.textContent = JSON.stringify(r.docs, null, 2);
      return;
    }
    tableWrap.innerHTML = `<table class="res db-table"><thead><tr><th class="db-rownum">#</th>${r.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
      <tbody>${r.rows.map((row, i) => `<tr><td class="db-rownum">${i + 1}</td>${row.map((v) => v === null ? `<td class="db-null">NULL</td>` : `<td title="${esc(v.length > 80 ? v.slice(0, 2000) : "")}">${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }
  root.querySelectorAll<HTMLElement>("[data-v]").forEach((b) => (b.onclick = () => { view = b.dataset.v as "table" | "json"; if (last) showResult(last); }));
  // double-click a cell: copy its value
  tableWrap.addEventListener("dblclick", (e) => {
    const td = (e.target as HTMLElement).closest("td");
    if (!td || td.classList.contains("db-rownum")) return;
    const tr = td.parentElement as HTMLTableRowElement;
    const v = last?.rows[tr.rowIndex - 1]?.[td.cellIndex - 1];
    invoke("clip_write", { text: v ?? "" }).then(() => toast("Значение скопировано"));
  });

  const csvCell = (v: string | null) => v === null ? "" : /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  $("[data-a=csv]").onclick = () => {
    if (!last) return;
    const text = [last.columns.map(csvCell).join(","), ...last.rows.map((r) => r.map(csvCell).join(","))].join("\n");
    invoke("clip_write", { text }).then(() => toast(`CSV скопирован: ${last!.rows.length} строк`));
  };
  $("[data-a=json]").onclick = () => {
    if (!last) return;
    const data = last.docs ?? last.rows.map((r) => Object.fromEntries(last!.columns.map((c, i) => [c, r[i]])));
    invoke("clip_write", { text: JSON.stringify(data, null, 2) }).then(() => toast(`JSON скопирован: ${data.length} записей`));
  };

  // ----- editor / results splitter -----
  const splitter = $(".db-hsplit");
  const savedH = Number(ls.get("opsdeck.db.editorH"));
  if (savedH) editor.style.height = `${savedH}px`;
  splitter.addEventListener("pointerdown", (e) => {
    const y0 = e.clientY, h0 = editor.offsetHeight;
    splitter.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => { editor.style.height = `${Math.max(60, Math.min(window.innerHeight - 200, h0 + ev.clientY - y0))}px`; };
    const up = () => { splitter.removeEventListener("pointermove", move); splitter.removeEventListener("pointerup", up); ls.set("opsdeck.db.editorH", String(editor.offsetHeight)); };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up);
  });

  $("[data-a=add]").onclick = () => openDialog(null);
  registerProvider(() => [
    { group: "Базы данных", title: "Новое подключение к базе", run: () => { window.dispatchEvent(new CustomEvent("show-view", { detail: "db" })); openDialog(null); } },
    ...profiles.map((p) => ({
      group: "Базы данных", title: p.name, hint: `${ENGINES[p.engine]?.label} ${p.host}`,
      run: () => { window.dispatchEvent(new CustomEvent("show-view", { detail: "db" })); select(p); editor.focus(); },
    })),
  ]);
  window.addEventListener("view-shown", (e) => { if ((e as CustomEvent).detail === "db") load(); });
  load();
}
