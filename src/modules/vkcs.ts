import { icon } from "./icons";
import { vkcsInvoke as invoke } from "./vkcs-request";
import { ask, esc, toast } from "./ui";
import { helpBtn } from "./help-btn";
import { natCmp } from "./natsort";
import { statusClass, vmSpec } from "./yc";
import { mountVkcsLog } from "./vkcs-log";

type Status = { found: boolean; version: string; cloud: string; clouds: string[]; project_id: string; projects?: Named[]; error: string; bin: string; config_path: string };
type Named = { id: string; name: string; parent: string; description: string };
type Instance = {
  id: string; name: string; status: string; zone: string; platform: string; flavor_id?: string; cores: number; memory: number;
  core_fraction: number; preemptible: boolean; internal_ip: string; public_ip: string; subnet_id: string;
};
type Subnet = { id: string; name: string; network_id: string; zone: string; cidrs: string[]; route_table_id: string };
type Rule = { direction: string; protocol: string; ports: string; source: string; description: string };
type SecGroup = { id: string; name: string; network_id: string; rules: Rule[] };
type Address = { id: string; address: string; external: boolean; reserved: boolean; used: boolean; zone: string; name: string };
type AccessRow = { role: string; kind: string; subject: string };
type AccessView = { rows: AccessRow[]; denied: boolean };
type VkcsBilling = { ok: boolean; need_pid: boolean; pid: string; base: string; bonus: string; currency: string; error: string };
type VkcsReportRow = { day: string; service: string; resource: string; parameter: string; money: string; bonus: string };
type VkcsBillingReport = { ok: boolean; need_pid: boolean; pid: string; currency: string; error: string; rows: VkcsReportRow[] };
type FlavorEntry = { name: string; cores: number; memory: number };
type InstanceMaps = { flavors: Record<string, FlavorEntry>; floating: Record<string, string> };
type SecGroupRulesChunk = { group_id: string; rules: Rule[] };

class TabLoadAborted extends Error {
  constructor() { super("aborted"); }
}

class TabLoadFailed extends Error {
  constructor(readonly html: string, message: string) { super(message); }
}

const TABS = [
  ["vm", "Машины"],
  ["net", "Сети"],
  ["sg", "Группы безопасности"],
  ["ip", "Адреса"],
  ["iam", "Доступы"],
  ["bill", "Счёт"],
] as const;
type TabId = (typeof TABS)[number][0];

const VKCS_CLI_DOCS = "https://cloud.vk.ru/docs/ru/tools-for-using-services/cli/openstack-cli";

export function mountVkcs(root: HTMLElement) {
  root.innerHTML = `
    <div class="page vkcs">
      <div class="page-head">
        <h2>VK Cloud ${helpBtn("vkcs")}</h2>
      <div class="row">
        <select class="vkcs-cloud" title="Облако из clouds.yaml"></select>
        <select class="vkcs-project" title="Проект OpenStack"></select>
        <button class="ghost" data-a="projects-refresh" title="Загрузить список проектов из облака">Обновить проекты</button>
        <button class="ghost" data-a="cli-docs" title="Документация VK Cloud: установка и настройка OpenStack CLI">Документация CLI</button>
        <button class="ghost" data-a="vkcs-yaml" title="Если clouds.yaml лежит не в ~/.config/openstack/">Путь к clouds.yaml…</button>
        <button class="icon" data-a="refresh" title="Обновить">${icon("refresh", 16)}</button>
        </div>
      </div>
      <p class="vkcs-err err" hidden></p>
      <p class="vkcs-nobin" hidden>
        <button class="ghost" data-a="vkcs-path">Указать путь к openstack…</button>
        <span class="muted">Приложение из меню не наследует PATH из терминала, куда pip кладёт Scripts.</span>
      </p>
      <p class="vkcs-config muted" hidden></p>
      <div class="tabbar vkcs-tabs">${TABS.map(([id, t], n) => `<button data-t="${id}" class="${n === 0 ? "active" : ""}">${t}</button>`).join("")}</div>
      <div class="vkcs-body"><div class="table-wrap"><table class="res"><thead><tr><th>Имя</th><th>Состояние</th><th>Зона</th><th>Конфигурация</th><th>Адреса</th><th></th></tr></thead><tbody><tr class="skeleton-row"><td colspan="6"><span class="skeleton-cell" style="width:40%;display:block"></span></td></tr></tbody></table></div></div>
      <div class="vkcs-log-dock"></div>
    </div>`;

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const body = $(".vkcs-body"), errEl = $(".vkcs-err");
  const cloudEl = $<HTMLSelectElement>(".vkcs-cloud"), projectEl = $<HTMLSelectElement>(".vkcs-project");
  let tab: TabId = "vm";
  let cloud = "";
  let project = "";
  let loadSeq = 0;
  let contextSeq = 0;
  let selectionSave: Promise<void> = Promise.resolve();
  let projectsReady = false;
  const cache = new Map<string, string>();
  const flavorCache = new Map<string, Record<string, FlavorEntry>>();
  const deniedAccess = new Set<string>();
  const tabLoads = new Map<string, { promise: Promise<string>; preview?: string }>();
  const cacheKeyFor = (t: TabId) => `${cloud}\0${project}\0${t}`;
  const cacheKey = () => cacheKeyFor(tab);
  const clearCache = () => { prefetchGen++; cache.clear(); tabLoads.clear(); deniedAccess.clear(); billReportHtml = null; };
  let prefetchGen = 0;

  const localIso = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  const defaultBillRange = () => {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - 6);
    return { from: localIso(from), to: localIso(to) };
  };
  let billFrom = defaultBillRange().from;
  let billTo = defaultBillRange().to;
  /** HTML гранулярного отчёта после явной загрузки; баланс подгружается отдельно. */
  let billReportHtml: string | null = null;

  const opts = (list: { id: string; name: string }[], sel: string) =>
    list.map((x) => `<option value="${esc(x.id)}"${x.id === sel ? " selected" : ""}>${esc(x.name || x.id)}</option>`).join("");

  function fail(e: unknown) {
    errEl.textContent = String(e);
    errEl.hidden = false;
  }

  function resetContext() {
    contextSeq++;
    loadSeq++;
    clearCache();
    errEl.hidden = true;
    body.classList.remove("vkcs-cached");
    body.innerHTML = empty("Загрузка проектов…");
    return contextSeq;
  }

  // Serialize persistence as well as ignoring old replies: an older save must not win on disk.
  async function saveSelection(seq: number) {
    const selected = { cloud, project };
    selectionSave = selectionSave.catch(() => {}).then(async () => {
      if (seq !== contextSeq) return;
      await invoke("vkcs_use_cloud", { name: selected.cloud });
      if (seq !== contextSeq) return;
      await invoke("vkcs_use_project", { id: selected.project });
    });
    await selectionSave;
  }

  async function fillProjects(seq: number, want = "") {
    const selectedCloud = cloud;
    if (!selectedCloud) return;
    const list = await invoke<Named[]>("vkcs_projects", { cloud: selectedCloud });
    if (seq !== contextSeq) return;
    const sorted = [...list].sort((a, b) => natCmp(a.name, b.name));
    const sel = sorted.some((x) => x.id === want) ? want : sorted[0]?.id ?? "";
    projectEl.innerHTML = opts(sorted, sel);
    project = sel;
    projectsReady = true;
    projectEl.disabled = !project;
    await saveSelection(seq);
  }

  async function selectCloud(next: string, want = "") {
    const seq = resetContext();
    cloud = next;
    project = "";
    projectsReady = false;
    projectEl.innerHTML = "";
    projectEl.disabled = true;
    root.classList.add("loading");
    try {
      await fillProjects(seq, want);
      if (seq === contextSeq) await draw();
    } catch (e) {
      if (seq !== contextSeq) return;
      fail(e);
      showTabError(tab, String(e));
    } finally {
      if (seq === contextSeq) root.classList.remove("loading");
    }
  }

  const table = (head: string[], rows: string) =>
    `<div class="table-wrap"><table class="res"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
  const empty = (what: string) => `<p class="muted pad">${what}</p>`;

  const skeletonRows = (cols: number, n = 6) => {
    const w = [
      [65, 45, 55, 70, 50, 30],
      [50, 35, 40, 60, 45, 25],
      [75, 50, 35, 55, 40, 30],
      [55, 40, 45, 50, 35, 25],
      [70, 45, 40, 65, 50, 30],
      [60, 35, 50, 45, 40, 25],
    ];
    return w.slice(0, n).map((row) =>
      `<tr class="skeleton-row">${Array.from({ length: cols }, (_, i) =>
        `<td><span class="skeleton-cell" style="width:${row[i % row.length]}%"></span></td>`).join("")}</tr>`,
    ).join("");
  };

  const skeletonTable = (head: string[], rows = 6) => table(head, skeletonRows(head.length, rows));

  function showSkeleton(forTab: TabId = tab) {
    if (forTab === "vm") body.innerHTML = skeletonTable(["Имя", "Состояние", "Зона", "Конфигурация", "Адреса", ""]);
    else if (forTab === "net") {
      body.innerHTML = Array.from({ length: 2 }, () =>
        `<details class="vkcs-group" open><summary><span class="skeleton-cell" style="display:inline-block;width:42%;height:14px"></span></summary>${skeletonTable(["Подсеть", "CIDR", ""], 3)}</details>`,
      ).join("");
    } else if (forTab === "sg") {
      body.innerHTML = Array.from({ length: 2 }, () =>
        `<details class="vkcs-group" open><summary><span class="skeleton-cell" style="display:inline-block;width:38%;height:14px"></span></summary>${skeletonTable(["Направление", "Протокол", "Порты", "Откуда / куда", "Описание"], 4)}</details>`,
      ).join("");
    } else if (forTab === "ip") body.innerHTML = skeletonTable(["Адрес", "Привязан к", "Занят"], 4);
    else if (forTab === "iam") body.innerHTML = `<h3 class="pad">Роли на проект</h3>${skeletonTable(["Роль", "Тип", "Кому"], 5)}`;
  }

  function showTabError(forTab: TabId, msg: string) {
    body.classList.remove("vkcs-cached");
    const head = forTab === "iam" ? `<h3 class="pad">Роли на проект</h3>` : "";
    body.innerHTML = `${head}<p class="err pad">${esc(String(msg))}</p>`;
  }

  function commitBody(forTab: TabId, seq: number, html: string) {
    if (seq !== loadSeq || tab !== forTab) return false;
    body.innerHTML = html;
    return true;
  }

  async function init() {
    const seq = resetContext();
    projectsReady = false;
    cloud = "";
    project = "";
    projectEl.innerHTML = "";
    projectEl.disabled = true;
    tab = "vm";
    root.querySelectorAll(".vkcs-tabs [data-t]").forEach((x, n) => x.classList.toggle("active", n === 0));
    root.classList.add("loading");
    showSkeleton();
    const s = await invoke<Status>("vkcs_status").catch((e) => { if (seq === contextSeq) fail(e); return null; });
    if (seq !== contextSeq) return;
    if (!s) {
      root.classList.remove("loading");
      showTabError(tab, errEl.textContent || "Не удалось загрузить VK Cloud");
      return;
    }
    errEl.hidden = !s.error;
    errEl.textContent = s.error;
    const cfgEl = $(".vkcs-config");
    if (s.config_path) {
      cfgEl.textContent = `clouds.yaml: ${s.config_path}`;
      cfgEl.hidden = false;
    } else {
      cfgEl.hidden = true;
    }
    $(".vkcs-nobin").hidden = s.found;
    if (!s.found) {
      root.classList.remove("loading");
      body.innerHTML = `<p class="muted">Нужен OpenStack CLI: установите <code>python-openstackclient</code> и настройте <code>~/.config/openstack/clouds.yaml</code> (или <code>source openrc.sh</code> в терминале для проверки). OpsDeck не хранит ни паролей, ни токенов.</p>
        <p><button class="ghost" data-a="cli-docs">Документация: настройка OpenStack CLI</button></p>`;
      return;
    }
    const clouds = s.clouds.length ? s.clouds.map((c) => ({ id: c, name: c })) : await invoke<Named[]>("vkcs_clouds").catch((e) => { if (seq === contextSeq) fail(e); return [] as Named[]; });
    if (seq !== contextSeq) return;
    cloud = clouds.some((c) => c.id === s.cloud) ? s.cloud : clouds[0]?.id ?? "";
    cloudEl.innerHTML = opts(clouds, cloud);
    if (!cloud) {
      body.innerHTML = empty("Нет облаков в clouds.yaml");
      root.classList.remove("loading");
      return;
    }
    if (cloud === s.cloud && s.project_id) {
      project = s.project_id;
      const knownName = s.projects?.find((p) => p.id === project)?.name;
      const projects = s.projects?.some((p) => p.id === project)
        ? s.projects.map((p) => p.id === project && (!p.name || p.name === p.id) ? { ...p, name: "Загрузка имени проекта…" } : p)
        : [{ id: project, name: "Загрузка имени проекта…" }];
      projectEl.innerHTML = opts(projects, project);
      projectEl.disabled = false;
      projectsReady = true;
      if (!knownName || knownName === project) {
        const selectedCloud = cloud, selectedProject = project;
        // Migrate settings which saved only the UUID. Fetch just this project's
        // name once, without reloading the project list or delaying resources.
        void invoke<Named>("vkcs_project", { cloud, projectId: project }).then((named) => {
          if (seq !== contextSeq || cloud !== selectedCloud || project !== selectedProject) return;
          const option = Array.from(projectEl.options).find((o) => o.value === selectedProject);
          if (option) option.textContent = named.name || "Выбранный проект";
        }).catch((e) => {
          if (seq !== contextSeq || cloud !== selectedCloud || project !== selectedProject) return;
          const option = Array.from(projectEl.options).find((o) => o.value === selectedProject);
          if (option) option.textContent = "Выбранный проект";
          fail(e);
        });
      }
      await draw();
    } else {
      await selectCloud(cloud);
    }
  }

  const ctx = () => ({ cloud, projectId: project });

  function enrichInstances(list: Instance[], maps: InstanceMaps): Instance[] {
    return list.map((i) => {
      let platform = i.platform;
      let cores = i.cores;
      let memory = i.memory;
      const byId = maps.flavors[i.flavor_id || i.platform];
      const byName = byId ?? Object.values(maps.flavors).find((f) => f.name === i.platform);
      if (byName) {
        platform = byName.name;
        cores = byName.cores;
        memory = byName.memory;
      }
      let public_ip = i.public_ip;
      if (!public_ip && i.internal_ip) public_ip = maps.floating[i.internal_ip] ?? "";
      return { ...i, platform, cores, memory, public_ip };
    });
  }

  function mergeSecGroups(groups: SecGroup[], chunks: SecGroupRulesChunk[]): SecGroup[] {
    const rules = new Map(chunks.map((c) => [c.group_id, c.rules]));
    return groups.map((g) => ({ ...g, rules: rules.get(g.id) ?? g.rules }));
  }

  function vmsHtml(list: Instance[], pending = false) {
    if (!list.length) return empty("В проекте нет машин");
    return table(
      ["Имя", "Состояние", "Зона", "Конфигурация", "Адреса", ""],
      [...list].sort((a, b) => natCmp(a.name, b.name)).map((i) => `
        <tr data-id="${esc(i.id)}" data-ip="${esc(i.public_ip || i.internal_ip)}">
          <td class="mt-name">${esc(i.name)}</td>
          <td class="${statusClass(i.status)}">${esc(i.status)}</td>
          <td class="muted">${esc(i.zone)}</td>
          <td class="muted">${pending && !i.cores && !i.memory ? '<span class="skeleton-cell" style="display:block;width:70%"></span>' : esc(vmSpec(i))}</td>
          <td class="mono">${esc(i.internal_ip)}${i.public_ip ? ` · <b>${esc(i.public_ip)}</b>` : ""}</td>
          <td class="mt-acts">
            ${i.public_ip || i.internal_ip ? `<button class="ghost" data-a="ssh" title="Открыть ssh во вкладке терминала">SSH</button>` : ""}
            ${i.status === "RUNNING"
              ? `<button class="icon" data-a="restart" title="Перезагрузить">${icon("refresh", 14)}</button><button class="icon danger" data-a="stop" title="Выключить">⏹</button>`
              : `<button class="icon" data-a="start" title="Включить">${icon("play", 14)}</button>`}
          </td></tr>`).join(""),
    );
  }

  function netsHtml(nets: Named[], subs: Subnet[], state: "pending" | "ready" | "error" = "ready") {
    if (!nets.length) return empty("В проекте нет сетей");
    const pending = state === "pending";
    return nets.map((n) => {
      const mine = subs.filter((s) => s.network_id === n.id || s.network_id === n.name).sort((a, b) => natCmp(a.name, b.name));
      return `<details class="vkcs-group" open><summary><b>${esc(n.name || n.id)}</b> <span class="muted">${esc(n.id)} · подсетей ${pending ? "…" : state === "error" ? "?" : mine.length}</span></summary>
        ${state === "error" ? empty("Не удалось загрузить подсети") : pending
          ? skeletonTable(["Подсеть", "CIDR", ""], 3)
          : mine.length
            ? table(["Подсеть", "CIDR", ""], mine.map((s) => `<tr>
                <td class="mt-name">${esc(s.name || s.id)}</td>
                <td class="mono">${esc(s.cidrs.join(", "))}</td><td class="muted mono">${esc(s.id)}</td></tr>`).join(""))
            : empty("нет подсетей")}</details>`;
    }).join("");
  }

  function secGroupsHtml(list: SecGroup[], state: "pending" | "ready" | "error" = "ready") {
    if (!list.length) return empty("В проекте нет групп безопасности");
    return list.map((g) => `
      <details class="vkcs-group" open><summary><b>${esc(g.name || g.id)}</b> <span class="muted">${esc(g.id)} · правил ${state === "pending" ? "…" : state === "error" ? "?" : g.rules.length}</span></summary>
        ${state === "error" ? empty("Не удалось загрузить правила") : g.rules.length
          ? table(["Направление", "Протокол", "Порты", "Откуда / куда", "Описание"], g.rules.map((r) => `<tr>
              <td>${r.direction === "INGRESS" ? "входящее" : "исходящее"}</td><td class="mono">${esc(r.protocol)}</td>
              <td class="mono">${esc(r.ports)}</td><td class="mono">${esc(r.source)}</td><td class="muted">${esc(r.description)}</td></tr>`).join(""))
          : state === "pending" ? skeletonTable(["Направление", "Протокол", "Порты", "Откуда / куда", "Описание"], 4) : empty("нет правил")}</details>`).join("");
  }

  function addressesHtml(list: Address[]) {
    if (!list.length) return empty("В проекте нет плавающих адресов");
    return table(
      ["Адрес", "Привязан к", "Занят"],
      list.map((a) => `<tr><td class="mono">${esc(a.address)}</td><td class="muted mono">${esc(a.zone)}</td>
        <td class="${a.used ? "" : "warn"}">${a.used ? "да" : "нет (платный простой)"}</td></tr>`).join(""),
    );
  }

  function iamHtml(rows: AccessRow[]) {
    return `<h3 class="pad">Роли на проект</h3>
      ${rows.length ? table(["Роль", "Тип", "Кому"], rows.map((b) => `<tr><td class="mono">${esc(b.role)}</td><td class="muted">${esc(b.kind)}</td><td class="mono">${esc(b.subject)}</td></tr>`).join("")) : empty("нет назначенных ролей")}`;
  }

  async function loadTabHtml(t: TabId, onPaint: (html: string) => void): Promise<string> {
    const epoch = contextSeq;
    const c = ctx();
    const assertContext = () => {
      if (epoch !== contextSeq) throw new TabLoadAborted();
    };
    const paint = (html: string) => {
      assertContext();
      onPaint(html);
      return html;
    };
    if (t === "vm") {
      let list = await invoke<Instance[]>("vkcs_server_list", c);
      assertContext();
      if (!list.length) return paint(empty("В проекте нет машин"));
      list = [...list].sort((a, b) => natCmp(a.name, b.name));
      const flavorKey = `${c.cloud}\0${c.projectId}`;
      const cached = flavorCache.get(flavorKey);
      const preview = cached ? enrichInstances(list, { flavors: cached, floating: {} }) : list;
      paint(vmsHtml(preview, true));
      try {
        const maps = await invoke<InstanceMaps>("vkcs_instance_maps", c);
        assertContext();
        flavorCache.set(flavorKey, maps.flavors);
        list = enrichInstances(list, maps);
      } catch (e) {
        assertContext();
        throw new TabLoadFailed(vmsHtml(preview, true), `Не удалось загрузить конфигурации и плавающие адреса: ${e}`);
      }
      return paint(vmsHtml(list));
    }
    if (t === "net") {
      const nets = await invoke<Named[]>("vkcs_networks", c);
      assertContext();
      if (!nets.length) return paint(empty("В проекте нет сетей"));
      paint(netsHtml(nets, [], "pending"));
      try {
        const subs = await invoke<Subnet[]>("vkcs_subnets", c);
        assertContext();
        return paint(netsHtml(nets, subs));
      } catch (e) {
        assertContext();
        throw new TabLoadFailed(netsHtml(nets, [], "error"), `Не удалось загрузить подсети: ${e}`);
      }
    }
    if (t === "sg") {
      let groups = await invoke<SecGroup[]>("vkcs_sec_groups_shell", c);
      assertContext();
      if (!groups.length) return paint(empty("В проекте нет групп безопасности"));
      paint(secGroupsHtml(groups, "pending"));
      try {
        const chunks = await invoke<SecGroupRulesChunk[]>("vkcs_sec_group_rules", c);
        assertContext();
        groups = mergeSecGroups(groups, chunks);
      } catch (e) {
        assertContext();
        throw new TabLoadFailed(secGroupsHtml(groups, "error"), `Не удалось загрузить правила: ${e}`);
      }
      return paint(secGroupsHtml(groups));
    }
    if (t === "ip") {
      const list = await invoke<Address[]>("vkcs_addresses", c);
      assertContext();
      return paint(addressesHtml(list));
    }
    if (t === "iam") {
      const access = await invoke<AccessView>("vkcs_access", c);
      assertContext();
      if (access.denied) {
        deniedAccess.add(cacheKeyFor(t));
        return paint(`<h3 class="pad">Роли на проект</h3><p class="muted pad">Нет разрешения на просмотр назначенных ролей в этом проекте. Другие разделы облака доступны независимо от этого разрешения.</p><p class="pad"><button class="ghost" data-a="access-retry">Проверить права снова</button></p>`);
      }
      deniedAccess.delete(cacheKeyFor(t));
      return paint(iamHtml(access.rows));
    }
    return "";
  }

  function sharedTabLoad(t: TabId) {
    const key = cacheKeyFor(t);
    const current = tabLoads.get(key);
    if (current) return current;
    const epoch = contextSeq;
    const task: { promise: Promise<string>; preview?: string } = { promise: Promise.resolve("") };
    task.promise = loadTabHtml(t, (html) => {
      task.preview = html;
      if (epoch === contextSeq && tab === t && cacheKeyFor(t) === key) commitBody(t, loadSeq, html);
    }).then((html) => {
      if (epoch === contextSeq) cache.set(key, html);
      return html;
    }).finally(() => {
      if (tabLoads.get(key) === task) tabLoads.delete(key);
    });
    tabLoads.set(key, task);
    return task;
  }

  /** Тихо подгружает следующие вкладки по очереди — переключение без ожидания openstack. */
  async function prefetchRest(fromIdx: number) {
    const gen = prefetchGen;
    for (let i = fromIdx + 1; i < TABS.length; i++) {
      if (gen !== prefetchGen || !project) return;
      const tid = TABS[i][0];
      if (tid === "bill") continue;
      if (cache.has(cacheKeyFor(tid))) continue;
      try {
        const html = await sharedTabLoad(tid).promise;
        if (gen !== prefetchGen) return;
        cache.set(cacheKeyFor(tid), html);
      } catch { /* фон — ошибку покажем при открытии вкладки */ }
    }
  }

  function paintTabPreview() {
    const k = cacheKey();
    const preview = tabLoads.get(k)?.preview;
    if (preview !== undefined) {
      body.innerHTML = preview;
      body.classList.remove("vkcs-cached");
    } else if (cache.has(k)) {
      body.innerHTML = cache.get(k)!;
      body.classList.add("vkcs-cached");
    } else if (tab !== "bill") {
      body.classList.remove("vkcs-cached");
      showSkeleton(tab);
    } else {
      body.classList.remove("vkcs-cached");
    }
  }

  async function draw(force = false) {
    const seq = ++loadSeq;
    prefetchGen++;
    const t = tab;
    const key = cacheKeyFor(t);
    const had = cache.has(key);
    if (t === tab) paintTabPreview();
    if (t === "iam" && !force && deniedAccess.has(key) && cache.has(key)) {
      body.classList.remove("vkcs-cached");
      root.classList.remove("loading");
      return;
    }

    root.classList.add("loading");
    try {
      if (!project && t !== "bill") {
        if (seq !== loadSeq || tab !== t) return;
        commitBody(t, seq, empty("Выберите проект"));
        body.classList.remove("vkcs-cached");
        return;
      }
      if (t === "bill") {
        if (seq !== loadSeq || tab !== t) return;
        await drawBilling(seq);
        return;
      }
      let html: string;
      try {
        html = await sharedTabLoad(t).promise;
      } catch (e) {
        if (e instanceof TabLoadAborted) return;
        throw e;
      }
      if (!commitBody(t, seq, html)) return;
      cache.set(key, html);
      body.classList.remove("vkcs-cached");
      prefetchGen++;
      void prefetchRest(TABS.findIndex(([id]) => id === t));
    } catch (e) {
      if (seq !== loadSeq || tab !== t) return;
      const msg = e instanceof Error ? e.message : String(e);
      if (had) {
        commitBody(t, seq, `${cache.get(key)!}<p class="err pad">${esc(`Не удалось обновить данные. Показаны последние загруженные данные: ${msg}`)}</p>`);
        body.classList.add("vkcs-cached");
      } else {
        cache.delete(key);
        if (e instanceof TabLoadFailed) commitBody(t, seq, `${e.html}<p class="err pad">${esc(msg)}</p>`);
        else showTabError(t, msg);
      }
    } finally {
      if (seq === loadSeq) {
        root.classList.remove("loading");
      }
    }
  }

  async function drawBilling(seq: number) {
    const webBtn = `<p><button class="ghost" data-a="billing-web">Открыть личный кабинет</button></p>`;
    const bindWeb = () => {
      body.querySelector<HTMLElement>("[data-a=billing-web]")?.addEventListener("click", () =>
        invoke("open_external", { url: "https://msk.cloud.vk.ru/" }).catch((e) => toast(String(e), "err")));
    };
    const bindPid = (b: VkcsBilling) => {
      if (!b.need_pid) return;
      body.querySelector<HTMLElement>("[data-a=billing-pid]")?.addEventListener("click", async () => {
        const pid = await ask(
          "PID проекта VK Cloud",
          "Идентификатор вида mcs0123456789 из списка проектов в шапке личного кабинета",
          { input: b.pid, placeholder: "mcs0123456789", ok: "Сохранить" },
        );
        if (!pid) return;
        try {
          await invoke("vkcs_set_billing_pid", { projectId: project, pid });
          toast("PID сохранён");
          billReportHtml = null;
          void draw();
        } catch (e) { toast(String(e), "err"); }
      });
    };
    const reportTableHtml = (r: VkcsBillingReport, cur: string) => {
      if (!r.ok) return `<p class="err pad">${esc(r.error)}</p>`;
      if (!r.rows.length) return `<p class="muted pad">За выбранные даты строк в отчёте нет.</p>`;
      const rows = r.rows.map((x) =>
        `<tr><td class="mono">${esc(x.day)}</td><td>${esc(x.service)}</td><td class="muted">${esc(x.resource)}</td>
         <td class="muted">${esc(x.parameter)}</td><td class="mono">${esc(x.money)} ${esc(cur)}</td><td class="mono">${esc(x.bonus)}</td></tr>`,
      ).join("");
      return `<p class="muted pad">${r.rows.length} строк</p>${table(["День", "Услуга", "Ресурс", "Параметр", "Деньги", "Бонусы"], rows)}`;
    };
    const reportSection = (currency: string) =>
      `<h3 class="pad">Гранулярный отчёт</h3>
      <p class="muted pad">Детализация расходов за период — отдельный запрос к Billing API (рекомендуется не больше месяца).</p>
      <div class="row pad vkcs-bill-range">
        <label class="muted">С <input type="date" data-a="bill-from" value="${esc(billFrom)}"></label>
        <label class="muted">По <input type="date" data-a="bill-to" value="${esc(billTo)}"></label>
        <button class="ghost" data-a="bill-report-load">Загрузить отчёт</button>
      </div>
      <div class="vkcs-report-out">${billReportHtml ?? '<p class="muted pad">Выберите период и нажмите «Загрузить отчёт».</p>'}</div>`;

    const bindReportLoad = (currency: string, liveSeq: number) => {
      const fromEl = body.querySelector<HTMLInputElement>("[data-a=bill-from]");
      const toEl = body.querySelector<HTMLInputElement>("[data-a=bill-to]");
      const out = body.querySelector<HTMLElement>(".vkcs-report-out");
      fromEl?.addEventListener("change", () => { if (fromEl.value) billFrom = fromEl.value; });
      toEl?.addEventListener("change", () => { if (toEl.value) billTo = toEl.value; });
      body.querySelector<HTMLElement>("[data-a=bill-report-load]")?.addEventListener("click", async () => {
        if (fromEl?.value) billFrom = fromEl.value;
        if (toEl?.value) billTo = toEl.value;
        if (!out || liveSeq !== loadSeq || tab !== "bill") return;
        out.innerHTML = `<p class="muted pad">Загрузка отчёта…</p>`;
        try {
          const r = await invoke<VkcsBillingReport>("vkcs_billing_report", {
            cloud, projectId: project, dateFrom: billFrom, dateTo: billTo,
          });
          if (liveSeq !== loadSeq || tab !== "bill") return;
          billReportHtml = reportTableHtml(r, r.currency || currency);
          out.innerHTML = billReportHtml;
          if (r.need_pid) {
            out.insertAdjacentHTML("beforeend", `<p><button class="ghost" data-a="billing-pid">Указать PID проекта (mcs…)…</button></p>`);
            body.querySelector<HTMLElement>("[data-a=billing-pid]")?.addEventListener("click", async () => {
              const pid = await ask("PID проекта VK Cloud", "Идентификатор вида mcs0123456789", { input: r.pid, placeholder: "mcs0123456789", ok: "Сохранить" });
              if (!pid) return;
              await invoke("vkcs_set_billing_pid", { projectId: project, pid });
              toast("PID сохранён");
              billReportHtml = null;
              void draw();
            });
          }
        } catch (e) {
          if (liveSeq !== loadSeq || tab !== "bill") return;
          out.innerHTML = `<p class="err pad">${esc(String(e))}</p>`;
        }
      });
    };

    if (!project) {
      commitBody("bill", seq, `<p class="muted">Выберите проект OpenStack — баланс запрашивается по PID проекта VK Cloud через Billing API.</p>${webBtn}`);
      bindWeb();
      return;
    }
    commitBody("bill", seq, `<p class="muted pad">Запрос баланса…</p>`);
    try {
      const b = await invoke<VkcsBilling>("vkcs_billing", { cloud, projectId: project });
      if (seq !== loadSeq || tab !== "bill") return;
      if (b.ok) {
        commitBody(
          "bill",
          seq,
          `<p class="muted">Проект <span class="mono">${esc(b.pid)}</span> · Billing API</p>
          ${table(
            ["Счёт", "Баланс"],
            `<tr><td>Лицевой</td><td class="mono">${esc(b.base)} ${esc(b.currency)}</td></tr>
             <tr><td>Бонусный</td><td class="mono">${esc(b.bonus)} ${esc(b.currency)}</td></tr>`,
          )}${reportSection(b.currency)}${webBtn}`,
        );
        bindWeb();
        bindReportLoad(b.currency, seq);
        return;
      }
      let extra = "";
      if (b.need_pid) extra = `<p><button class="ghost" data-a="billing-pid">Указать PID проекта (mcs…)…</button></p>`;
      commitBody(
        "bill",
        seq,
        `<p class="err">${esc(b.error)}</p>${extra}<p class="muted">PID — идентификатор в шапке личного кабинета VK Cloud, не UUID OpenStack.</p>
        ${reportSection(b.currency || "RUB")}${webBtn}`,
      );
      bindWeb();
      bindReportLoad(b.currency || "RUB", seq);
      bindPid(b);
    } catch (e) {
      if (seq !== loadSeq || tab !== "bill") return;
      showTabError("bill", String(e));
    }
  }

  $(".vkcs-tabs").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-t]");
    if (!b) return;
    tab = b.dataset.t as TabId;
    root.querySelectorAll(".vkcs-tabs [data-t]").forEach((x) => x.classList.toggle("active", x === b));
    paintTabPreview();
    void draw();
  });

  body.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
    const tr = b?.closest<HTMLElement>("tr[data-id]");
    if (!b || !tr) return;
    const selected = ctx(), selectedSeq = contextSeq;
    const id = tr.dataset.id!, name = tr.querySelector(".mt-name")!.textContent ?? id;
    if (b.dataset.a === "ssh") {
      const ip = tr.dataset.ip!;
      window.dispatchEvent(new CustomEvent("open-terminal", { detail: { program: "ssh", args: [ip], title: name, keepOpen: true } }));
      return;
    }
    const op = b.dataset.a!;
    const what = op === "start" ? "Включить" : op === "stop" ? "Выключить" : "Перезагрузить";
    if ((await ask(`${what} машину`, `${what} «${name}»? Это настоящая машина в VK Cloud.`, { ok: what, danger: op !== "start" })) === null) return;
    if (selectedSeq !== contextSeq) return;
    try {
      await invoke("vkcs_instance_op", { ...selected, id, op });
      toast(`${what}: запрос отправлен, состояние обновится через несколько секунд`);
      setTimeout(() => { if (selectedSeq === contextSeq) void draw(); }, 3000);
    } catch (err) { toast(String(err), "err"); }
  });

  cloudEl.onchange = () => { void selectCloud(cloudEl.value); };
  $("[data-a=projects-refresh]").onclick = () => { void selectCloud(cloud, project); };
  projectEl.onchange = async () => {
    const seq = resetContext();
    project = projectEl.value;
    try {
      await saveSelection(seq);
      if (seq === contextSeq) await draw();
    } catch (e) {
      if (seq !== contextSeq) return;
      fail(e);
      showTabError(tab, String(e));
    }
  };
  $("[data-a=refresh]").onclick = () => {
    if (!projectsReady) { void (cloud ? selectCloud(cloud) : init()); return; }
    void draw(true);
  };
  const openCliDocs = () => invoke("open_external", { url: VKCS_CLI_DOCS }).catch((e) => toast(String(e), "err"));
  root.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("[data-a=access-retry]")) void draw(true);
    if ((e.target as HTMLElement).closest("[data-a=cli-docs]")) openCliDocs();
  });
  $("[data-a=vkcs-path]").onclick = async () => {
    const path = await ask("Путь к openstack", "Полный путь к исполняемому файлу OpenStack CLI", { input: "", placeholder: "~/AppData/Local/Programs/Python/Python312/Scripts/openstack.exe", ok: "Проверить и сохранить" });
    if (!path) return;
    try {
      await invoke("vkcs_set_path", { path });
      toast("Путь сохранён");
      await init();
    } catch (e) { toast(String(e), "err"); }
  };
  $("[data-a=vkcs-yaml]").onclick = async () => {
    const path = await ask("Путь к clouds.yaml", "Полный путь к файлу конфигурации OpenStack (clouds.yaml)", { input: "", placeholder: "~/.config/openstack/clouds.yaml", ok: "Проверить и сохранить" });
    if (!path) return;
    try {
      await invoke("vkcs_set_clouds_yaml", { path });
      toast("Путь к clouds.yaml сохранён");
      await init();
    } catch (e) { toast(String(e), "err"); }
  };

  void mountVkcsLog($(".vkcs-log-dock")).then(() => init());
}
