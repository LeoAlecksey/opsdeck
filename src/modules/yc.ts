import { icon } from "./icons";
import { invoke } from "@tauri-apps/api/core";
import { ask, esc, toast } from "./ui";
import { helpBtn } from "./help";
import { natCmp } from "./natsort";
import { fmtSize } from "./paths";

type Status = { found: boolean; version: string; profile: string; profiles: string[]; cloud_id: string; folder_id: string; error: string };
type Named = { id: string; name: string; parent: string; description: string };
type Instance = {
  id: string; name: string; status: string; zone: string; platform: string; cores: number; memory: number;
  core_fraction: number; preemptible: boolean; internal_ip: string; public_ip: string; subnet_id: string;
};
type Subnet = { id: string; name: string; network_id: string; zone: string; cidrs: string[]; route_table_id: string };
type Rule = { direction: string; protocol: string; ports: string; source: string; description: string };
type SecGroup = { id: string; name: string; network_id: string; rules: Rule[] };
type Address = { id: string; address: string; reserved: boolean; used: boolean; zone: string; name: string };
type Binding = { role: string; kind: string; subject: string };
type BillingAccount = { id: string; name: string; balance: string; currency: string; active: boolean };

const TABS = [
  ["vm", "Машины"],
  ["net", "Сети"],
  ["sg", "Группы безопасности"],
  ["ip", "Адреса"],
  ["iam", "Доступы"],
  ["bill", "Счёт"],
] as const;
type TabId = (typeof TABS)[number][0];

/** Состояние машины в цвет: работает — зелёный, остановлена — серый, остальное (запускается, ошибка) — жёлтый. */
export function statusClass(status: string) {
  return status === "RUNNING" ? "ok" : status === "STOPPED" ? "muted" : "warn";
}

/** «standard-v3 · 2 vCPU (20%) · 4.0 GB» — то, за что платят. */
export function vmSpec(i: { platform: string; cores: number; memory: number; core_fraction: number; preemptible: boolean }) {
  const parts = [i.platform, `${i.cores} vCPU${i.core_fraction && i.core_fraction !== 100 ? ` (${i.core_fraction}%)` : ""}`, fmtSize(i.memory)];
  if (i.preemptible) parts.push("прерываемая");
  return parts.filter(Boolean).join(" · ");
}

export function mountYc(root: HTMLElement) {
  root.innerHTML = `
    <div class="page yc">
      <div class="page-head">
        <h2>Yandex Cloud ${helpBtn("yc")}</h2>
      <div class="row">
        <select class="yc-profile" title="Профиль yc"></select>
        <select class="yc-cloud" title="Облако"></select>
        <select class="yc-folder" title="Каталог"></select>
        <button class="icon" data-a="refresh" title="Обновить">${icon("refresh", 16)}</button>
        </div>
      </div>
      <p class="yc-err err" hidden></p>
      <div class="tabbar yc-tabs">${TABS.map(([id, t], n) => `<button data-t="${id}" class="${n === 0 ? "active" : ""}">${t}</button>`).join("")}</div>
      <div class="yc-body"></div>
    </div>`;

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const body = $(".yc-body"), errEl = $(".yc-err");
  const profileEl = $<HTMLSelectElement>(".yc-profile"), cloudEl = $<HTMLSelectElement>(".yc-cloud"), folderEl = $<HTMLSelectElement>(".yc-folder");
  let tab: TabId = "vm";
  let folder = "";
  let loading = false;

  const opts = (list: { id: string; name: string }[], sel: string) =>
    list.map((x) => `<option value="${esc(x.id)}"${x.id === sel ? " selected" : ""}>${esc(x.name || x.id)}</option>`).join("");

  function fail(e: unknown) {
    errEl.textContent = String(e);
    errEl.hidden = false;
  }

  async function init() {
    const s = await invoke<Status>("yc_status").catch((e) => { fail(e); return null; });
    if (!s) return;
    errEl.hidden = !s.error;
    errEl.textContent = s.error;
    profileEl.innerHTML = opts(s.profiles.map((p) => ({ id: p, name: p })), s.profile);
    profileEl.hidden = s.profiles.length < 2;
    if (!s.found) {
      body.innerHTML = `<p class="pad muted">Нужен Yandex Cloud CLI: установите <code>yc</code> и выполните <code>yc init</code> в терминале. OpsDeck работает его профилями и не хранит ни токенов, ни ключей.</p>`;
      return;
    }
    const clouds = await invoke<Named[]>("yc_clouds").catch((e) => { fail(e); return [] as Named[]; });
    cloudEl.innerHTML = opts([...clouds].sort((a, b) => natCmp(a.name, b.name)), s.cloud_id);
    await fillFolders(cloudEl.value || s.cloud_id, s.folder_id);
    draw();
  }

  async function fillFolders(cloud: string, want = "") {
    if (!cloud) return;
    const list = await invoke<Named[]>("yc_folders", { cloudId: cloud }).catch((e) => { fail(e); return [] as Named[]; });
    folderEl.innerHTML = opts([...list].sort((a, b) => natCmp(a.name, b.name)), want);
    folder = folderEl.value || want;
  }

  const table = (head: string[], rows: string) =>
    `<div class="table-wrap"><table class="res"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
  const empty = (what: string) => `<p class="muted pad">${what}</p>`;

  async function draw() {
    if (loading) return;
    loading = true;
    body.innerHTML = `<p class="muted pad">…</p>`;
    try {
      if (!folder && tab !== "bill") {
        body.innerHTML = empty("Выберите каталог");
        return;
      }
      if (tab === "vm") await drawVms();
      else if (tab === "net") await drawNets();
      else if (tab === "sg") await drawSecGroups();
      else if (tab === "ip") await drawAddresses();
      else if (tab === "iam") await drawIam();
      else await drawBilling();
    } catch (e) {
      body.innerHTML = `<p class="err pad">${esc(String(e))}</p>`;
    } finally {
      loading = false;
    }
  }

  async function drawVms() {
    const list = await invoke<Instance[]>("yc_instances", { folderId: folder });
    if (!list.length) return void (body.innerHTML = empty("В каталоге нет машин"));
    body.innerHTML = table(
      ["Имя", "Состояние", "Зона", "Конфигурация", "Адреса", ""],
      [...list].sort((a, b) => natCmp(a.name, b.name)).map((i) => `
        <tr data-id="${esc(i.id)}" data-ip="${esc(i.public_ip || i.internal_ip)}">
          <td class="mt-name">${esc(i.name)}</td>
          <td class="${statusClass(i.status)}">${esc(i.status)}</td>
          <td class="muted">${esc(i.zone)}</td>
          <td class="muted">${esc(vmSpec(i))}</td>
          <td class="mono">${esc(i.internal_ip)}${i.public_ip ? ` · <b>${esc(i.public_ip)}</b>` : ""}</td>
          <td class="mt-acts">
            ${i.public_ip || i.internal_ip ? `<button class="ghost" data-a="ssh" title="Открыть ssh во вкладке терминала">SSH</button>` : ""}
            ${i.status === "RUNNING"
              ? `<button class="icon" data-a="restart" title="Перезагрузить">${icon("refresh", 14)}</button><button class="icon danger" data-a="stop" title="Выключить">⏹</button>`
              : `<button class="icon" data-a="start" title="Включить">${icon("play", 14)}</button>`}
          </td></tr>`).join(""),
    );
  }

  async function drawNets() {
    const [nets, subs] = await Promise.all([invoke<Named[]>("yc_networks", { folderId: folder }), invoke<Subnet[]>("yc_subnets", { folderId: folder })]);
    if (!nets.length) return void (body.innerHTML = empty("В каталоге нет сетей"));
    body.innerHTML = nets.map((n) => {
      const mine = subs.filter((s) => s.network_id === n.id).sort((a, b) => natCmp(a.name, b.name));
      return `<details class="yc-group" open><summary><b>${esc(n.name || n.id)}</b> <span class="muted">${esc(n.id)} · подсетей ${mine.length}</span></summary>
        ${mine.length
          ? table(["Подсеть", "Зона", "Адреса", "Таблица маршрутов"], mine.map((s) => `<tr>
              <td class="mt-name">${esc(s.name || s.id)}</td><td class="muted">${esc(s.zone)}</td>
              <td class="mono">${esc(s.cidrs.join(", "))}</td><td class="muted mono">${esc(s.route_table_id)}</td></tr>`).join(""))
          : empty("нет подсетей")}</details>`;
    }).join("");
  }

  async function drawSecGroups() {
    const list = await invoke<SecGroup[]>("yc_sec_groups", { folderId: folder });
    if (!list.length) return void (body.innerHTML = empty("В каталоге нет групп безопасности"));
    body.innerHTML = list.map((g) => `
      <details class="yc-group" open><summary><b>${esc(g.name || g.id)}</b> <span class="muted">${esc(g.id)} · правил ${g.rules.length}</span></summary>
        ${g.rules.length
          ? table(["Направление", "Протокол", "Порты", "Откуда / куда", "Описание"], g.rules.map((r) => `<tr>
              <td>${r.direction === "INGRESS" ? "входящее" : "исходящее"}</td><td class="mono">${esc(r.protocol)}</td>
              <td class="mono">${esc(r.ports)}</td><td class="mono">${esc(r.source)}</td><td class="muted">${esc(r.description)}</td></tr>`).join(""))
          : empty("нет правил — трафик не разрешён")}</details>`).join("");
  }

  async function drawAddresses() {
    const list = await invoke<Address[]>("yc_addresses", { folderId: folder });
    if (!list.length) return void (body.innerHTML = empty("В каталоге нет публичных адресов"));
    body.innerHTML = table(
      ["Адрес", "Имя", "Зона", "Зарезервирован", "Занят"],
      list.map((a) => `<tr><td class="mono">${esc(a.address)}</td><td>${esc(a.name)}</td><td class="muted">${esc(a.zone)}</td>
        <td>${a.reserved ? "да" : "нет"}</td><td class="${a.used ? "" : "warn"}">${a.used ? "да" : "нет (платный простой)"}</td></tr>`).join(""),
    );
  }

  async function drawIam() {
    const [accs, binds] = await Promise.all([invoke<Named[]>("yc_service_accounts", { folderId: folder }), invoke<Binding[]>("yc_bindings", { folderId: folder })]);
    body.innerHTML = `
      <h3 class="pad">Сервисные аккаунты</h3>
      ${accs.length ? table(["Имя", "Идентификатор", "Описание"], accs.map((a) => `<tr><td class="mt-name">${esc(a.name)}</td><td class="mono muted">${esc(a.id)}</td><td class="muted">${esc(a.description)}</td></tr>`).join("")) : empty("нет сервисных аккаунтов")}
      <h3 class="pad">Права на каталог</h3>
      ${binds.length ? table(["Роль", "Кому", "Кто"], binds.map((b) => `<tr><td class="mono">${esc(b.role)}</td><td class="muted">${esc(b.kind)}</td><td class="mono">${esc(b.subject)}</td></tr>`).join("")) : empty("нет назначенных прав")}`;
  }

  async function drawBilling() {
    const list = await invoke<BillingAccount[]>("yc_billing");
    if (!list.length) return void (body.innerHTML = empty("Платёжные аккаунты не видны этому профилю"));
    body.innerHTML = table(
      ["Платёжный аккаунт", "Баланс", "Состояние"],
      list.map((b) => `<tr><td class="mt-name">${esc(b.name || b.id)}</td><td class="mono">${esc(b.balance)} ${esc(b.currency)}</td>
        <td class="${b.active ? "ok" : "warn"}">${b.active ? "активен" : "неактивен"}</td></tr>`).join(""),
    );
  }

  $(".yc-tabs").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-t]");
    if (!b) return;
    tab = b.dataset.t as TabId;
    root.querySelectorAll(".yc-tabs [data-t]").forEach((x) => x.classList.toggle("active", x === b));
    draw();
  });

  body.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
    const tr = b?.closest<HTMLElement>("tr[data-id]");
    if (!b || !tr) return;
    const id = tr.dataset.id!, name = tr.querySelector(".mt-name")!.textContent ?? id;
    if (b.dataset.a === "ssh") {
      const ip = tr.dataset.ip!;
      window.dispatchEvent(new CustomEvent("open-terminal", { detail: { program: "ssh", args: [ip], title: name, keepOpen: true } }));
      return;
    }
    const op = b.dataset.a!;
    const what = op === "start" ? "Включить" : op === "stop" ? "Выключить" : "Перезагрузить";
    if ((await ask(`${what} машину`, `${what} «${name}»? Это настоящая машина в Yandex Cloud.`, { ok: what, danger: op !== "start" })) === null) return;
    try {
      await invoke("yc_instance_op", { id, op });
      toast(`${what}: запрос отправлен, состояние обновится через несколько секунд`);
      setTimeout(draw, 3000);
    } catch (err) { toast(String(err), "err"); }
  });

  cloudEl.onchange = async () => { await fillFolders(cloudEl.value); draw(); };
  folderEl.onchange = () => { folder = folderEl.value; draw(); };
  profileEl.onchange = async () => {
    try {
      await invoke("yc_use_profile", { name: profileEl.value });
      await init();
    } catch (e) { fail(e); }
  };
  $("[data-a=refresh]").onclick = () => draw();

  init();
}
