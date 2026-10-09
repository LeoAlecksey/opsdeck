import { helpBtn } from "./help";
import { icon } from "./icons";
import { locale, t } from "../i18n";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ask, esc, toast } from "./ui";
import { age, detailsHtml, jsonPath, statusClass } from "./k8s-details";
import { decodeSecret } from "./secretval";
import { registerProvider } from "./palette";
import { matches, parseSelector, type Term } from "./labelsel";
import type { OpenTerminalDetail } from "./terminal";

type CtxInfo = {
  file: string; source: string; label: string; context: string; cluster: string;
  user: string; namespace: string; current: boolean; server: string;
};
type Ctx = { file: string; context: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any;
type Col = { h: string; v: (o: Obj) => string | number; sort?: (o: Obj) => string | number; cls?: (o: Obj) => string; html?: (o: Obj) => string };

// ---------- column helpers ----------

const ts = (s?: string) => (s ? Date.parse(s) : 0);
const name: Col = { h: "Имя", v: (o) => o.metadata.name };
const ns: Col = { h: "Namespace", v: (o) => o.metadata.namespace ?? "" };
const ageCol: Col = { h: "Возраст", v: (o) => age(o.metadata.creationTimestamp), sort: (o) => -ts(o.metadata.creationTimestamp) };
const keys = (o: Obj) => Object.keys(o.data ?? {}).length + Object.keys(o.binaryData ?? {}).length;

function podStatus(p: Obj): string {
  if (p.metadata.deletionTimestamp) return "Terminating";
  for (const c of p.status?.initContainerStatuses ?? []) {
    const t = c.state?.terminated, w = c.state?.waiting;
    if (t && t.exitCode !== 0) return `Init:${t.reason ?? "Error"}`;
    if (w?.reason && w.reason !== "PodInitializing") return `Init:${w.reason}`;
  }
  let reason = p.status?.reason ?? p.status?.phase ?? "Unknown";
  for (const c of p.status?.containerStatuses ?? []) {
    if (c.state?.waiting?.reason) reason = c.state.waiting.reason;
    else if (c.state?.terminated?.reason && !c.ready) reason = c.state.terminated.reason;
  }
  return reason;
}
const ready = (have?: number, want?: number) => `${have ?? 0}/${want ?? 0}`;
const readyCls = (have?: number, want?: number) => ((have ?? 0) >= (want ?? 0) ? "ok" : "warn");
const nodeReady = (n: Obj) => {
  const c = (n.status?.conditions ?? []).find((c: Obj) => c.type === "Ready");
  const s = c?.status === "True" ? "Ready" : "NotReady";
  return n.spec?.unschedulable ? `${s},SchedulingDisabled` : s;
};

const argoSrc = (o: Obj) => o.spec?.source ?? o.spec?.sources?.[0] ?? {};
const argoSync = (o: Obj) => o.status?.sync?.status ?? "Unknown";
const argoHealth = (o: Obj) => o.status?.health?.status ?? "Unknown";
const helmStatusCls = (s: string) => (s === "deployed" ? "ok" : s === "failed" ? "bad" : s === "superseded" || s === "uninstalled" ? "muted" : "warn");

/** Quantities → millicores / bytes (same rules as the backend). */
function cpuMilli(q?: string): number {
  if (!q) return 0;
  const m = /^([\d.]+)([num]?)$/.exec(q);
  if (!m) return 0;
  return Number(m[1]) * ({ n: 1e-6, u: 1e-3, m: 1, "": 1000 } as Record<string, number>)[m[2]];
}
function memBytes(q?: string): number {
  if (!q) return 0;
  const m = /^([\d.]+)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(q);
  if (!m) return 0;
  const mult: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, k: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  return Number(m[1]) * (m[2] ? mult[m[2]] : 1);
}
const fmtMem = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)}Gi` : `${Math.round(b / 1024 ** 2)}Mi`);

type KindDef = { id: string; label: string; group: string; namespaced: boolean; cols: Col[]; source?: "helm" | "history"; crd?: boolean };
type CrdInfo = { id: string; group: string; version: string; kind: string; plural: string; namespaced: boolean;
  columns: { name: string; type: string; jsonPath: string }[] };

/** Table definition for a custom resource from its printer columns (what `kubectl get` shows). */
function crdKind(c: CrdInfo): KindDef {
  const cols: Col[] = [name];
  if (c.namespaced) cols.push(ns);
  for (const pc of c.columns) {
    if (pc.jsonPath === ".metadata.creationTimestamp") continue; // the age column is always added
    cols.push(pc.type === "date"
      ? { h: pc.name, v: (o) => age(jsonPath(o, pc.jsonPath)), sort: (o) => -ts(jsonPath(o, pc.jsonPath)) }
      : { h: pc.name, v: (o) => jsonPath(o, pc.jsonPath), cls: (o) => {
        const v = jsonPath(o, pc.jsonPath);
        return /status|ready|health|sync|phase|state/i.test(pc.name) && v ? statusClass(v === "True" ? "Ready" : v) : "";
      } });
  }
  cols.push(ageCol);
  return { id: c.id, label: c.kind, group: c.group, namespaced: c.namespaced, cols, crd: true };
}

const eventCols: Col[] = [
  { h: "Когда", v: (o) => age(o.lastTimestamp ?? o.eventTime ?? o.metadata.creationTimestamp), sort: (o) => -ts(o.lastTimestamp ?? o.eventTime ?? o.metadata.creationTimestamp) },
  { h: "Тип", v: (o) => o.type ?? "", cls: (o) => (o.type === "Warning" ? "warn" : "muted") },
  ns,
  { h: "Объект", v: (o) => `${o.involvedObject?.kind ?? ""}/${o.involvedObject?.name ?? ""}` },
  { h: "Причина", v: (o) => o.reason ?? "" },
  { h: "Сообщение", v: (o) => o.message ?? "", cls: () => "wrap" },
  { h: "×", v: (o) => o.count ?? 1, sort: (o) => -(o.count ?? 1) }];

const KINDS: KindDef[] = [
  { id: "pods", label: "Pods", group: "Workloads", namespaced: true, cols: [
    name, ns,
    { h: "Ready", v: (o) => { const cs = o.status?.containerStatuses ?? []; return `${cs.filter((c: Obj) => c.ready).length}/${o.spec.containers.length}`; } },
    { h: "Статус", v: podStatus, cls: (o) => statusClass(podStatus(o)) },
    { h: "Рестарты", v: (o) => (o.status?.containerStatuses ?? []).reduce((a: number, c: Obj) => a + (c.restartCount ?? 0), 0),
      cls: (o) => ((o.status?.containerStatuses ?? []).some((c: Obj) => c.restartCount > 0) ? "warn" : "") },
    { h: "Нода", v: (o) => o.spec.nodeName ?? "" },
    { h: "IP", v: (o) => o.status?.podIP ?? "" },
    ageCol] },
  { id: "deployments", label: "Deployments", group: "Workloads", namespaced: true, cols: [
    name, ns,
    { h: "Ready", v: (o) => ready(o.status?.readyReplicas, o.spec.replicas), cls: (o) => readyCls(o.status?.readyReplicas, o.spec.replicas) },
    { h: "Up-to-date", v: (o) => o.status?.updatedReplicas ?? 0 },
    { h: "Available", v: (o) => o.status?.availableReplicas ?? 0 },
    ageCol] },
  { id: "statefulsets", label: "StatefulSets", group: "Workloads", namespaced: true, cols: [
    name, ns,
    { h: "Ready", v: (o) => ready(o.status?.readyReplicas, o.spec.replicas), cls: (o) => readyCls(o.status?.readyReplicas, o.spec.replicas) },
    ageCol] },
  { id: "daemonsets", label: "DaemonSets", group: "Workloads", namespaced: true, cols: [
    name, ns,
    { h: "Desired", v: (o) => o.status?.desiredNumberScheduled ?? 0 },
    { h: "Ready", v: (o) => o.status?.numberReady ?? 0, cls: (o) => readyCls(o.status?.numberReady, o.status?.desiredNumberScheduled) },
    ageCol] },
  { id: "replicasets", label: "ReplicaSets", group: "Workloads", namespaced: true, cols: [
    name, ns,
    { h: "Ready", v: (o) => ready(o.status?.readyReplicas, o.spec.replicas), cls: (o) => readyCls(o.status?.readyReplicas, o.spec.replicas) },
    ageCol] },
  { id: "jobs", label: "Jobs", group: "Workloads", namespaced: true, cols: [
    name, ns,
    { h: "Completions", v: (o) => `${o.status?.succeeded ?? 0}/${o.spec.completions ?? 1}` },
    { h: "Статус", v: (o) => (o.status?.failed ? "Failed" : o.status?.succeeded ? "Completed" : "Running"),
      cls: (o) => (o.status?.failed ? "bad" : o.status?.succeeded ? "muted" : "warn") },
    ageCol] },
  { id: "cronjobs", label: "CronJobs", group: "Workloads", namespaced: true, cols: [
    name, ns,
    { h: "Расписание", v: (o) => o.spec.schedule },
    { h: "Suspend", v: (o) => (o.spec.suspend ? "да" : ""), cls: (o) => (o.spec.suspend ? "warn" : "") },
    { h: "Последний запуск", v: (o) => age(o.status?.lastScheduleTime), sort: (o) => -ts(o.status?.lastScheduleTime) },
    ageCol] },
  { id: "services", label: "Services", group: "Сеть", namespaced: true, cols: [
    name, ns,
    { h: "Тип", v: (o) => o.spec.type },
    { h: "Cluster IP", v: (o) => o.spec.clusterIP ?? "" },
    { h: "External", v: (o) => (o.status?.loadBalancer?.ingress ?? []).map((i: Obj) => i.ip ?? i.hostname).join(", ") },
    { h: "Порты", v: (o) => (o.spec.ports ?? []).map((p: Obj) => `${p.port}${p.nodePort ? ":" + p.nodePort : ""}/${p.protocol}`).join(", ") },
    ageCol] },
  { id: "ingresses", label: "Ingresses", group: "Сеть", namespaced: true, cols: [
    name, ns,
    { h: "Class", v: (o) => o.spec.ingressClassName ?? "" },
    { h: "Хосты", v: (o) => (o.spec.rules ?? []).map((r: Obj) => r.host ?? "*").join(", ") },
    { h: "Адрес", v: (o) => (o.status?.loadBalancer?.ingress ?? []).map((i: Obj) => i.ip ?? i.hostname).join(", ") },
    ageCol] },
  { id: "configmaps", label: "ConfigMaps", group: "Конфигурация", namespaced: true, cols: [name, ns, { h: "Ключи", v: keys }, ageCol] },
  { id: "secrets", label: "Secrets", group: "Конфигурация", namespaced: true, cols: [name, ns, { h: "Тип", v: (o) => o.type }, { h: "Ключи", v: keys }, ageCol] },
  { id: "persistentvolumeclaims", label: "PVC", group: "Хранилище", namespaced: true, cols: [
    name, ns,
    { h: "Статус", v: (o) => o.status?.phase ?? "", cls: (o) => statusClass(o.status?.phase ?? "") },
    { h: "Размер", v: (o) => o.status?.capacity?.storage ?? o.spec.resources?.requests?.storage ?? "" },
    { h: "StorageClass", v: (o) => o.spec.storageClassName ?? "" },
    ageCol] },
  { id: "persistentvolumes", label: "PV", group: "Хранилище", namespaced: false, cols: [
    name,
    { h: "Статус", v: (o) => o.status?.phase ?? "", cls: (o) => statusClass(o.status?.phase ?? "") },
    { h: "Размер", v: (o) => o.spec.capacity?.storage ?? "" },
    { h: "Claim", v: (o) => (o.spec.claimRef ? `${o.spec.claimRef.namespace}/${o.spec.claimRef.name}` : "") },
    ageCol] },
  { id: "nodes", label: "Nodes", group: "Кластер", namespaced: false, cols: [
    name,
    { h: "Статус", v: nodeReady, cls: (o) => (nodeReady(o) === "Ready" ? "ok" : "bad") },
    { h: "Роли", v: (o) => Object.keys(o.metadata.labels ?? {}).filter((l) => l.startsWith("node-role.kubernetes.io/")).map((l) => l.split("/")[1]).join(",") },
    { h: "Версия", v: (o) => o.status?.nodeInfo?.kubeletVersion ?? "" },
    { h: "IP", v: (o) => (o.status?.addresses ?? []).find((a: Obj) => a.type === "InternalIP")?.address ?? "" },
    ageCol] },
  { id: "namespaces", label: "Namespaces", group: "Кластер", namespaced: false, cols: [
    name, { h: "Статус", v: (o) => o.status?.phase ?? "", cls: (o) => statusClass(o.status?.phase ?? "") }, ageCol] },
  { id: "events", label: "Events", group: "Кластер", namespaced: true, cols: eventCols },
  // recorded by OpsDeck (k8s_events.rs): events kept for a week instead of the cluster's hour (#55)
  { id: "event-history", label: "История событий", group: "Кластер", namespaced: true, source: "history", cols: eventCols },
  { id: "applications", label: "Applications", group: "Argo CD", namespaced: true, cols: [
    name, ns,
    { h: "Sync", v: argoSync, cls: (o) => (argoSync(o) === "Synced" ? "ok" : argoSync(o) === "OutOfSync" ? "warn" : "muted") },
    { h: "Health", v: argoHealth, cls: (o) => ({ Healthy: "ok", Progressing: "warn", Suspended: "muted", Missing: "bad", Degraded: "bad" } as Record<string, string>)[argoHealth(o)] ?? "muted" },
    { h: "Репозиторий", v: (o) => String(argoSrc(o).repoURL ?? "").replace(/^https?:\/\//, "").replace(/\.git$/, "") },
    { h: "Путь / чарт", v: (o) => argoSrc(o).path ?? argoSrc(o).chart ?? "" },
    { h: "Ревизия", v: (o) => argoSrc(o).targetRevision ?? "HEAD" },
    { h: "Назначение", v: (o) => `${o.spec?.destination?.namespace ?? ""}${o.spec?.destination?.name ? " @ " + o.spec.destination.name : ""}` },
    ageCol] },
  { id: "helm", label: "Releases", group: "Helm", namespaced: true, source: "helm", cols: [
    name, ns,
    { h: "Ревизия", v: (o) => o.revision, sort: (o) => o.revision },
    { h: "Статус", v: (o) => o.status ?? "", cls: (o) => helmStatusCls(o.status) },
    { h: "Chart", v: (o) => o.chart ?? "" },
    { h: "App version", v: (o) => o.app_version ?? "" },
    { h: "Обновлён", v: (o) => age(o.updated), sort: (o) => -ts(o.updated) }] },
];

// ---------- log view: buffer + text/pod filter over an xterm ----------

type LogLine = { pod?: string; text: string };
const LOG_CAP = 50000;
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

class LogView {
  private lines: LogLine[] = [];
  private text = "";
  private pod = "";
  constructor(readonly term: Terminal) {}
  private match = (l: LogLine) =>
    (!this.pod || l.pod === this.pod) && (!this.text || stripAnsi(l.text).toLowerCase().includes(this.text));
  add(ls: LogLine[]) {
    this.lines.push(...ls);
    if (this.lines.length > LOG_CAP) this.lines.splice(0, this.lines.length - LOG_CAP);
    const shown = ls.filter(this.match);
    if (shown.length) this.term.write(shown.map((l) => l.text).join("\n") + "\n");
  }
  setFilter(text: string, pod = this.pod) {
    this.text = text.trim().toLowerCase();
    this.pod = pod;
    this.term.reset();
    const shown = this.lines.filter(this.match);
    // write in chunks so a big buffer doesn't freeze the UI
    for (let i = 0; i < shown.length; i += 5000) this.term.write(shown.slice(i, i + 5000).map((l) => l.text).join("\n") + "\n");
  }
  clear() {
    this.lines = [];
    this.term.reset();
  }
  /** Selection, or the last `n` visible lines without colors. */
  tail(n = 150) {
    const sel = this.term.getSelection().trim();
    return sel || this.lines.filter(this.match).slice(-n).map((l) => stripAnsi(l.text)).join("\n");
  }
}

const POD_COLORS = [36, 33, 35, 32, 34, 91, 96, 93];
function podColor(pod: string) {
  let h = 0;
  for (const ch of pod) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return POD_COLORS[h % POD_COLORS.length];
}

// ---------- persistence ----------

const store = {
  get(k: string) { try { return localStorage.getItem(`opsdeck.k8s.${k}`); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(`opsdeck.k8s.${k}`, v); } catch { /* ignore */ } },
};

// ---------- view ----------

export function mountK8s(root: HTMLElement) {
  root.classList.add("k8s");
  root.innerHTML = `
    <aside class="k8s-side">
      <div class="side-head"><span>Кластеры</span><button class="icon" data-act="import" title="Импорт kubeconfig">${icon("plus", 16)}</button></div>
      <div class="ctx-list"></div>
      <div class="kind-list"></div>
    </aside>
    <div class="k8s-main">
      <div class="k8s-bar">
        <span class="ctx-title muted">выберите контекст</span>
        <span class="ro-badge" title="Изменения в этом контексте запрещены">${icon("lock", 14)} только чтение</span>
        <select class="ns-select" title="Namespace"></select>
        <input class="filter" placeholder="фильтр…" spellcheck="false" />
        <input class="lfilter" placeholder="метки: app=api, env in (prod)" spellcheck="false" title="Фильтр по меткам, как kubectl -l: app=api · tier!=db · env in (prod,stage) · env notin (dev) · canary (есть ключ) · !canary (нет ключа); условия через запятую" />
        <span class="spacer"></span>
        <span class="count muted"></span>
        <label class="muted auto" title="Живое обновление (watch): изменения в кластере появляются сразу"><input type="checkbox" class="auto-cb" checked /> live</label>
        <button class="icon" data-act="refresh" title="Обновить">${icon("refresh", 16)}</button>
        <button data-act="shell" title="Терминал с KUBECONFIG этого контекста (kubectl, helm, k9s)">${icon("k8s", 16)} Терминал</button>
        ${helpBtn("k8s")}
      </div>
      <div class="k8s-err err" hidden></div>
      <div class="hist-bar" hidden>
        <span class="hist-state"></span>
        <button class="ghost" data-act="hist-toggle"></button>
        <label class="check muted"><input type="checkbox" class="hist-warn" checked /> только Warning</label>
        <span class="hist-top"></span>
        <span class="spacer"></span>
        <button class="ghost" data-act="hist-clear" title="Забыть записанные события этого кластера">Очистить</button>
      </div>
      <div class="table-wrap"><table class="res"><thead></thead><tbody></tbody></table></div>
      <div class="drawer" hidden>
        <div class="drawer-head">
          <strong class="obj-title"></strong>
          <div class="drawer-tabs"></div>
          <span class="spacer"></span>
          <div class="drawer-actions"></div>
          <button class="icon" data-act="close-drawer" title="Закрыть">${icon("close", 16)}</button>
        </div>
        <div class="drawer-body"></div>
      </div>
    </div>
    <dialog class="import-dialog">
      <form method="dialog">
        <h3>Добавить кластеры в OpsDeck</h3>
        <p class="muted">OpsDeck хранит свои копии kubeconfig в ~/.config/opsdeck/kubeconfigs (права 600) и не меняет ваш ~/.kube/config — обычный kubectl работает как раньше.</p>
        <div class="imp-section">
          <div class="side-head small">Из ~/.kube/config</div>
          <div class="sys-list"><p class="muted">загрузка…</p></div>
          <div class="actions"><button value="sys" class="primary" formnovalidate>Скопировать выбранные</button></div>
        </div>
        <details class="imp-section">
          <summary class="side-head small">Вставить YAML или перетащить файл в окно</summary>
          <label>Имя <input name="name" placeholder="prod-cluster" spellcheck="false" /></label>
          <label>YAML <textarea name="yaml" rows="10" spellcheck="false" placeholder="apiVersion: v1&#10;kind: Config&#10;clusters: …"></textarea></label>
          <div class="actions"><button value="ok" class="primary" formnovalidate>Импортировать YAML</button></div>
        </details>
        <p class="err form-err"></p>
        <div class="actions"><button value="cancel" formnovalidate>Закрыть</button></div>
      </form>
    </dialog>`;

  const $ = <T extends HTMLElement = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const ctxList = $(".ctx-list"), kindList = $(".kind-list"), nsSel = $<HTMLSelectElement>(".ns-select");
  const lfilterIn = $<HTMLInputElement>(".lfilter");
  const histBar = $(".hist-bar");
  const filterIn = $<HTMLInputElement>(".filter"), errBox = $(".k8s-err"), thead = $("thead"), tbody = $("tbody");
  const drawer = $(".drawer"), drawerBody = $(".drawer-body"), countEl = $(".count"), autoCb = $<HTMLInputElement>(".auto-cb");

  let contexts: CtxInfo[] = [];
  let ctx: CtxInfo | null = null;
  let crdKinds: KindDef[] = [];
  const allKinds = () => [...KINDS, ...crdKinds];
  let kind = KINDS.find((k) => k.id === store.get("kind")) ?? KINDS[0];
  let items: Obj[] = [];
  let sortCol = 0, sortDir = 1;
  let selected: string | null = null; // "ns/name"
  let loadSeq = 0;
  let loading = false;
  let drawerCleanup: (() => void) | null = null;

  const ref = (): Ctx => ({ file: ctx!.file, context: ctx!.context });
  const keyOf = (o: Obj) => `${o.metadata.namespace ?? ""}/${o.metadata.name}`;
  const currentNs = () => (kind.namespaced ? nsSel.value : "");

  // ----- contexts -----

  type Prefs = { hidden: string[]; readonly: string[] };
  let prefs: Prefs = { hidden: [], readonly: [] };
  const ctxKey = (c: { file: string; context: string }) => `${c.file}|${c.context}`;
  const isReadonly = () => !!ctx && prefs.readonly.includes(ctxKey(ctx));

  async function setPref(c: CtxInfo, list: "hidden" | "readonly", on: boolean) {
    const k = ctxKey(c);
    prefs[list] = prefs[list].filter((x) => x !== k);
    if (on) prefs[list].push(k);
    await invoke("k8s_prefs_set", { prefs }).catch((e) => toast(String(e), "err"));
    if (list === "readonly") toast(on ? `${c.context}: только чтение` : `${c.context}: изменения разрешены`);
    if (list === "hidden" && on) toast(`${c.context} скрыт — вернуть можно внизу списка`);
    loadContexts();
  }

  function ctxButton(c: CtxInfo) {
    const ro = prefs.readonly.includes(ctxKey(c));
    const b = document.createElement("div");
    b.className = "ctx-item";
    b.dataset.key = ctxKey(c);
    b.classList.toggle("active", !!ctx && ctxKey(ctx) === ctxKey(c));
    b.classList.toggle("ro", ro);
    b.title = `${c.server}\ncluster: ${c.cluster}\nuser: ${c.user}`;
    b.innerHTML = `<span class="ctx-name">${c.current ? "● " : ""}${esc(c.context)}${ro ? ` ${icon("lock", 14)}` : ""}</span>
      <span class="ctx-server muted">${esc(c.server.replace(/^https?:\/\//, ""))}</span>
      <span class="ctx-acts">
        <button class="icon" data-p="ro" title="${ro ? "Разрешить изменения" : "Только чтение: запретить apply/delete/scale/restart/exec"}">${ro ? icon("lockOpen", 14) : icon("lock", 14)}</button>
        <button class="icon" data-p="hide" title="Скрыть контекст из списка">${icon("eyeOff", 14)}</button>
        <button class="icon" data-p="del" title="Удалить контекст из kubeconfig (с резервной копией)">${icon("trash", 14)}</button>
      </span>`;
    b.onclick = (e) => {
      const p = (e.target as HTMLElement).closest<HTMLElement>("[data-p]")?.dataset.p;
      if (p === "ro") return setPref(c, "readonly", !ro);
      if (p === "hide") return setPref(c, "hidden", true);
      if (p === "del") return deleteContext(c);
      selectContext(c);
    };
    return b;
  }

  async function deleteContext(c: CtxInfo) {
    const v = await ask("Удалить контекст",
      `Удалить «${c.context}» из ${c.file}? Кластер и пользователь тоже удалятся, если их не использует другой контекст. ` +
      `Перед изменением сохранится копия файла. Для подтверждения введите имя контекста.`,
      { input: "", placeholder: c.context, ok: "Удалить", danger: true });
    if (v === null) return;
    if (v !== c.context) return toast("Имя не совпало — ничего не удалено", "err");
    try {
      const backup = await invoke<string>("k8s_delete_context", { ctx: { file: c.file, context: c.context } });
      toast(`Контекст удалён. Резервная копия: ${backup}`);
      if (ctx && ctxKey(ctx) === ctxKey(c)) { ctx = null; stopWatch(); store.set("ctx", ""); items = []; closeDrawer(); render(); }
      loadContexts();
    } catch (e) { toast(String(e), "err"); }
  }

  /** Read-only context: banner + disabled mutating/exec controls. */
  function syncReadonly() {
    const ro = isReadonly();
    root.classList.toggle("readonly", ro);
    $("[data-act=shell]").toggleAttribute("disabled", ro);
    $("[data-act=shell]").title = ro ? "В режиме только чтения терминал с kubectl отключён" : "Терминал с KUBECONFIG этого контекста (kubectl, helm, k9s)";
  }

  async function loadContexts() {
    contexts = await invoke<CtxInfo[]>("k8s_contexts");
    const groups = new Map<string, CtxInfo[]>();
    prefs = await invoke<Prefs>("k8s_prefs_get").catch(() => ({ hidden: [], readonly: [] }));
    const visible = contexts.filter((c) => !prefs.hidden.includes(ctxKey(c)));
    const hidden = contexts.filter((c) => prefs.hidden.includes(ctxKey(c)));
    // OpsDeck's store keeps one file per context: show them as one group
    for (const c of visible) {
      const key = c.source === "opsdeck" ? "opsdeck" : c.file;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    ctxList.innerHTML = contexts.length ? "" : `<div class="pad empty-k8s"><p class="muted">В OpsDeck пока нет кластеров.</p>
      <button class="primary" data-act="import-empty">Добавить из ~/.kube/config</button></div>`;
    ctxList.querySelector<HTMLElement>("[data-act=import-empty]")?.addEventListener("click", () => openImport());
    for (const [file, list] of groups) {
      const g = document.createElement("div");
      g.className = "ctx-group";
      const own = file === "opsdeck";
      g.innerHTML = own
        ? `<div class="ctx-file" title="~/.config/opsdeck/kubeconfigs"><span>OpsDeck</span></div>`
        : list[0].source === "dir"
          ? `<div class="ctx-file" title="${esc(file)}"><span>${esc(list[0].label)}</span><span class="badge" title="${esc(t("Из папки в ⚙ → Kubernetes; файл читается на месте"))}">${esc(t("папка"))}</span></div>`
          : `<div class="ctx-file" title="${esc(file)}"><span>${esc(list[0].label)}</span><span class="badge warn" title="Общий kubeconfig: изменения затронут и обычный kubectl">общий</span></div>`;
      g.querySelector<HTMLElement>(".del")?.addEventListener("click", async () => {
        if ((await ask("Удалить kubeconfig", `Удалить импортированный файл «${list[0].label}»?`, { ok: "Удалить", danger: true })) === null) return;
        await invoke("k8s_remove_source", { file }).catch((e) => toast(String(e), "err"));
        if (ctx?.file === file) { ctx = null; stopWatch(); }
        loadContexts();
      });
      for (const c of list) g.appendChild(ctxButton(c));
      ctxList.appendChild(g);
    }
    if (hidden.length) {
      const g = document.createElement("details");
      g.className = "ctx-hidden";
      g.innerHTML = `<summary class="muted">Скрытые контексты (${hidden.length})</summary>`;
      for (const c of hidden) {
        const row = document.createElement("div");
        row.className = "ctx-hidden-row";
        row.innerHTML = `<span class="muted">${esc(c.context)}</span><button class="ghost" title="Вернуть в список">показать</button>`;
        row.querySelector("button")!.onclick = () => setPref(c, "hidden", false);
        g.appendChild(row);
      }
      ctxList.appendChild(g);
    }
    if (ctx && prefs.hidden.includes(ctxKey(ctx))) {
      // the selected context was just hidden: drop it
      ctx = null;
      stopWatch();
      store.set("ctx", "");
      $(".ctx-title").textContent = "выберите контекст";
      $(".ctx-title").classList.add("muted");
      items = [];
      closeDrawer();
      render();
    }
    syncReadonly();
    if (ctx && !contexts.some((c) => ctxKey(c) === ctxKey(ctx!))) {
      // the selected context is gone (deleted, or system configs switched off)
      ctx = null;
      stopWatch();
      $(".ctx-title").textContent = "выберите контекст";
      $(".ctx-title").classList.add("muted");
      items = [];
      closeDrawer();
      render();
    }
    if (!ctx) {
      const last = store.get("ctx");
      const pick = contexts.find((c) => `${c.file}|${c.context}` === last);
      if (pick) selectContext(pick);
    }
  }

  async function selectContext(c: CtxInfo) {
    ctx = c;
    store.set("ctx", `${c.file}|${c.context}`);
    ctxList.querySelectorAll<HTMLElement>(".ctx-item").forEach((b) => b.classList.toggle("active", b.dataset.key === ctxKey(c)));
    syncReadonly();
    $(".ctx-title").textContent = c.context;
    $(".ctx-title").classList.remove("muted");
    closeDrawer();
    items = [];
    root.classList.add("loading");
    render();
    await Promise.all([loadNamespaces(), loadCrds()]);
    usage.clear();
    startWatch();
    loadMetrics();
  }

  async function loadNamespaces() {
    const saved = store.get(`ns:${ctx!.file}|${ctx!.context}`);
    let names: string[] = [];
    try {
      names = (await invoke<Obj[]>("k8s_list", { ctx: ref(), kind: "namespaces", namespace: null })).map((n) => n.metadata.name).sort();
    } catch {
      // no RBAC for listing namespaces: offer the context default and manual entry
      names = [ctx!.namespace];
    }
    nsSel.innerHTML = "";
    nsSel.add(new Option("Все namespaces", ""));
    for (const n of names) nsSel.add(new Option(n, n));
    if (saved && !names.includes(saved) && saved !== "") nsSel.add(new Option(saved, saved));
    nsSel.add(new Option("Другой…", "__other"));
    nsSel.value = saved ?? (names.length > 1 ? "" : ctx!.namespace);
  }

  nsSel.onchange = async () => {
    if (nsSel.value === "__other") {
      const v = await ask("Namespace", "Имя namespace:", { input: "" });
      if (v) { if (![...nsSel.options].some((o) => o.value === v)) nsSel.add(new Option(v, v), nsSel.options.length - 1); nsSel.value = v; }
      else nsSel.value = "";
    }
    store.set(`ns:${ctx!.file}|${ctx!.context}`, nsSel.value);
    closeDrawer();
    startWatch();
    loadMetrics();
  };

  // ----- kinds -----

  async function loadCrds() {
    const list = await invoke<CrdInfo[]>("k8s_crds", { ctx: ref() }).catch(() => [] as CrdInfo[]);
    // Argo Applications already have a hand-made table
    crdKinds = list.filter((c) => !(c.group === "argoproj.io" && c.kind === "Application")).map(crdKind);
    const saved = store.get("kind");
    const restored = saved?.startsWith("crd:") ? crdKinds.find((k) => k.id === saved) : undefined;
    if (restored) kind = restored;
    else if (kind.crd && !crdKinds.some((k) => k.id === kind.id)) kind = KINDS[0]; // CRD missing in this cluster
    renderKinds();
  }

  function selectKind(k: KindDef) {
    kind = k;
    store.set("kind", k.id);
    sortCol = 0; sortDir = 1;
    closeDrawer();
    items = [];
    root.classList.add("loading");
    renderKinds();
    render();
    startWatch();
    loadMetrics();
  }

  function renderKinds() {
    const crdFilter = kindList.querySelector<HTMLInputElement>(".crd-filter")?.value ?? "";
    kindList.innerHTML = "";
    let group = "";
    for (const k of KINDS) {
      if (k.group !== group) {
        group = k.group;
        kindList.insertAdjacentHTML("beforeend", `<div class="side-head small">${esc(group)}</div>`);
      }
      const b = document.createElement("button");
      b.className = "kind-item";
      b.classList.toggle("active", k === kind);
      b.textContent = k.label;
      b.onclick = () => selectKind(k);
      kindList.appendChild(b);
    }
    if (crdKinds.length) {
      kindList.insertAdjacentHTML("beforeend", `<div class="side-head small">Custom resources <span class="muted">${crdKinds.length}</span></div>
        <input class="crd-filter" placeholder="фильтр CRD…" spellcheck="false" />`);
      const filter = kindList.querySelector<HTMLInputElement>(".crd-filter")!;
      filter.value = crdFilter;
      const q = crdFilter.trim().toLowerCase();
      const openGroups = new Set<string>(JSON.parse(store.get("crdOpen") ?? "[]") as string[]);
      const byGroup = new Map<string, KindDef[]>();
      for (const k of crdKinds) {
        if (q && !`${k.label} ${k.group}`.toLowerCase().includes(q)) continue;
        byGroup.set(k.group, [...(byGroup.get(k.group) ?? []), k]);
      }
      for (const [group, ks] of byGroup) {
        const d = document.createElement("details");
        d.className = "crd-group";
        d.open = !!q || openGroups.has(group) || ks.includes(kind);
        d.innerHTML = `<summary title="${esc(group)}">${esc(group)} <span class="muted">${ks.length}</span></summary>`;
        d.addEventListener("toggle", () => {
          d.open ? openGroups.add(group) : openGroups.delete(group);
          store.set("crdOpen", JSON.stringify([...openGroups]));
        });
        for (const k of ks) {
          const b = document.createElement("button");
          b.className = "kind-item crd-item";
          b.classList.toggle("active", k.id === kind.id);
          b.textContent = k.label;
          b.title = `${k.label}.${k.group}`;
          b.onclick = () => selectKind(k);
          d.appendChild(b);
        }
        kindList.appendChild(d);
      }
      let t = 0;
      filter.oninput = () => { clearTimeout(t); t = window.setTimeout(() => { renderKinds(); kindList.querySelector<HTMLInputElement>(".crd-filter")?.focus(); }, 150); };
    }
    nsSel.disabled = !kind.namespaced;
  }

  // ----- table -----

  // ----- live data: watch stream for API kinds, one-shot load for Helm -----

  let watchId = "";
  let unlistenWatch: (() => void) | null = null;
  let renderQueued = false;
  const queueRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; if (!root.hidden) render(); });
  };

  function stopWatch() {
    if (watchId) invoke("k8s_watch_stop", { id: watchId });
    unlistenWatch?.();
    unlistenWatch = null;
    watchId = "";
  }

  type WatchMsg = { type: "reset" | "apply" | "delete" | "error"; items?: Obj[]; uids?: string[]; message?: string; retrying?: boolean };

  async function startWatch() {
    stopWatch();
    if (!ctx) return;
    if (kind.source === "helm" || kind.source === "history" || !autoCb.checked) return refresh();
    const id = `w${++loadSeq}`;
    watchId = id;
    root.classList.add("loading");
    const un = await listen<WatchMsg>(`k8s-watch-${id}`, (e) => {
      if (watchId !== id) return;
      const m = e.payload;
      if (m.type === "error") {
        errBox.hidden = false;
        if (m.retrying) {
          errBox.classList.add("reconnecting");
          errBox.classList.remove("err");
          root.classList.add("loading");
          errBox.innerHTML = `<span>Нестабильное соединение с кластером, повторное подключение… <span class="muted">(${esc(m.message ?? "")})</span></span> <button class="ghost" data-act="watch-retry" style="margin-left:8px;padding:2px 8px;font-size:11.5px">Повторить</button>`;
          const btn = errBox.querySelector<HTMLButtonElement>("[data-act=watch-retry]");
          if (btn) btn.onclick = () => startWatch();
        } else {
          errBox.classList.remove("reconnecting");
          errBox.classList.add("err");
          errBox.textContent = m.message ?? "ошибка watch";
          root.classList.remove("loading");
          render();
        }
        return;
      }
      errBox.hidden = true;
      errBox.classList.remove("reconnecting");
      errBox.classList.add("err");
      errBox.textContent = "";
      if (m.type === "reset") { items = m.items ?? []; root.classList.remove("loading"); }
      if (m.type === "apply") {
        const byUid = new Map(items.map((o) => [o.metadata.uid, o]));
        for (const o of m.items ?? []) byUid.set(o.metadata.uid, o);
        items = [...byUid.values()];
      }
      if (m.type === "delete") { const gone = new Set(m.uids); items = items.filter((o) => !gone.has(o.metadata.uid)); }
      queueRender();
    });
    if (watchId !== id) { un(); return; }
    unlistenWatch = un;
    invoke("k8s_watch_start", { ctx: ref(), id, kind: kind.id, namespace: currentNs() || null })
      .catch((err) => { errBox.hidden = false; errBox.textContent = String(err); root.classList.remove("loading"); render(); });
  }

  async function refresh() {
    if (!ctx || loading) return;
    loading = true;
    const seq = ++loadSeq;
    root.classList.add("loading");
    try {
      const list = kind.source === "helm"
        ? await invoke<Obj[]>("k8s_helm_releases", { ctx: ref(), namespace: currentNs() || null })
        : kind.source === "history" ? await loadHistory()
        : await invoke<Obj[]>("k8s_list", { ctx: ref(), kind: kind.id, namespace: currentNs() || null });
      if (seq !== loadSeq) return;
      items = list;
      errBox.hidden = true;
      render();
    } catch (e) {
      if (seq !== loadSeq) return;
      errBox.hidden = false;
      errBox.textContent = String(e);
      render();
    } finally {
      loading = false;
      root.classList.remove("loading");
    }
  }

  // ----- event history (#55) -----
  const histWarn = $<HTMLInputElement>(".hist-warn");
  let histOn = false;
  async function loadHistory(): Promise<Obj[]> {
    const h = await invoke<{ enabled: boolean; rows: Obj[] }>("k8s_history", { ctx: ref(), warnings: histWarn.checked });
    histOn = h.enabled;
    const rows = currentNs() ? h.rows.filter((r) => r.metadata.namespace === currentNs()) : h.rows;
    drawHistBar(rows);
    return rows;
  }
  /** Recording state, and what fell over most in the last 24 h. */
  function drawHistBar(rows: Obj[]) {
    histBar.querySelector(".hist-state")!.innerHTML = histOn
      ? `<span class="ok">● ${esc(t("Запись идёт"))}</span> <span class="muted">${esc(t("— пока OpsDeck открыт, события хранятся неделю"))}</span>`
      : `<span class="muted">${esc(t("Запись выключена: Kubernetes хранит события около часа"))}</span>`;
    histBar.querySelector<HTMLElement>("[data-act=hist-toggle]")!.textContent = histOn ? t("Остановить запись") : t("Записывать события этого кластера");
    histBar.querySelector<HTMLElement>("[data-act=hist-toggle]")!.className = histOn ? "ghost" : "primary";
    const day = Date.now() - 24 * 3600 * 1000;
    const by = new Map<string, number>();
    for (const r of rows) if (new Date(r.lastTimestamp).getTime() >= day) by.set(r.reason ?? "", (by.get(r.reason ?? "") ?? 0) + (r.count ?? 1));
    const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    histBar.querySelector(".hist-top")!.innerHTML = top.length
      ? `<span class="muted">${esc(t("за 24 ч"))}:</span> ` + top.map(([r, n]) => `<button class="chip" data-reason="${esc(r)}" title="${esc(t("Показать только"))} ${esc(r)}">${esc(r)} ×${n}</button>`).join(" ")
      : "";
  }
  histBar.addEventListener("click", async (e) => {
    const el = e.target as HTMLElement;
    const reason = el.closest<HTMLElement>("[data-reason]")?.dataset.reason;
    if (reason !== undefined) { filterIn.value = reason; render(); return; }
    const act = el.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (!ctx) return;
    if (act === "hist-toggle") {
      await invoke("k8s_history_set", { ctx: ref(), on: !histOn }).catch((err) => toast(String(err), "err"));
      if (!histOn) toast(t("Запись событий включена — новые события появятся здесь"));
      refresh();
    }
    if (act === "hist-clear" && (await ask(t("Очистить историю"), t("Забыть записанные события этого кластера? Запись (если включена) продолжится."), { ok: t("Очистить"), danger: true })) !== null) {
      await invoke("k8s_history_clear", { ctx: ref() }).catch((err) => toast(String(err), "err"));
      refresh();
    }
  });
  histWarn.onchange = () => refresh();

  // ----- metrics-server -----

  type Usage = { namespace: string; name: string; cpu_m: number; mem: number };
  let usage = new Map<string, Usage>();
  let metricsFor = "";
  let metricsOk = false;
  const TREND = 30;
  const trend = new Map<string, { cpu: number[]; mem: number[] }>();
  let histFor = "";
  async function loadMetrics() {
    if (!ctx || root.hidden || !["pods", "nodes"].includes(kind.id)) return;
    const key = `${ctxKey(ctx)}|${kind.id}|${currentNs()}`;
    try {
      const list = await invoke<Usage[]>("k8s_metrics", { ctx: ref(), kind: kind.id, namespace: currentNs() || null });
      if (key !== `${ctx && ctxKey(ctx)}|${kind.id}|${currentNs()}`) return;
      usage = new Map(list.map((u) => [`${u.namespace}/${u.name}`, u]));
      if (kind.id === "nodes") {
        // a short history per node for the sparklines (cleared when the context changes)
        if (histFor !== key) { trend.clear(); histFor = key; }
        for (const u of list) {
          const h = trend.get(u.name) ?? { cpu: [], mem: [] };
          h.cpu.push(u.cpu_m); h.mem.push(u.mem);
          if (h.cpu.length > TREND) { h.cpu.shift(); h.mem.shift(); }
          trend.set(u.name, h);
        }
      }
      metricsFor = key;
      metricsOk = true;
    } catch {
      metricsOk = false; // no metrics-server or no RBAC: just no columns
    }
    queueRender();
  }
  const metricCols = (): Col[] => {
    if (!metricsOk || !ctx || metricsFor !== `${ctxKey(ctx)}|${kind.id}|${currentNs()}`) return [];
    const u = (o: Obj) => usage.get(`${o.metadata.namespace ?? ""}/${o.metadata.name}`);
    if (kind.id === "pods") return [
      { h: "CPU", v: (o) => (u(o) ? `${Math.round(u(o)!.cpu_m)}m` : ""), sort: (o) => -(u(o)?.cpu_m ?? -1) },
      { h: "RAM", v: (o) => (u(o) ? fmtMem(u(o)!.mem) : ""), sort: (o) => -(u(o)?.mem ?? -1) },
    ];
    const pct = (used: number, total: number) => (total ? ` · ${Math.round((used / total) * 100)}%` : "");
    const hot = (used: number, total: number) => (total && used / total > 0.85 ? "bad" : total && used / total > 0.7 ? "warn" : "");
    // live view of a node: a bar of the share used and a sparkline of the last samples
    const live = (o: Obj, text: string, used: number, total: number, series: number[]) => {
      const p = total ? Math.min(100, (used / total) * 100) : 0;
      const pts = series.length > 1 && total
        ? series.map((x, i) => `${((i / (TREND - 1)) * 60).toFixed(1)},${(16 - Math.min(1, x / total) * 15).toFixed(1)}`).join(" ")
        : "";
      return `<span class="k8s-live"><span class="k8s-bar-u"><i style="width:${p.toFixed(0)}%"></i></span>`
        + `${pts ? `<svg class="k8s-spark" viewBox="0 0 60 17" preserveAspectRatio="none"><polyline points="${pts}" /></svg>` : ""}`
        + `<span>${esc(text)}</span></span>`;
    };
    const cpuT = (o: Obj) => cpuMilli(o.status?.allocatable?.cpu), memT = (o: Obj) => memBytes(o.status?.allocatable?.memory);
    const cpuText = (o: Obj) => (u(o) ? `${Math.round(u(o)!.cpu_m)}m${pct(u(o)!.cpu_m, cpuT(o))}` : "");
    const memText = (o: Obj) => (u(o) ? `${fmtMem(u(o)!.mem)}${pct(u(o)!.mem, memT(o))}` : "");
    return [
      { h: "CPU", v: cpuText, sort: (o) => -(u(o)?.cpu_m ?? -1), cls: (o) => (u(o) ? hot(u(o)!.cpu_m, cpuT(o)) : ""),
        html: (o) => (u(o) ? live(o, cpuText(o), u(o)!.cpu_m, cpuT(o), trend.get(o.metadata.name)?.cpu ?? []) : "") },
      { h: "RAM", v: memText, sort: (o) => -(u(o)?.mem ?? -1), cls: (o) => (u(o) ? hot(u(o)!.mem, memT(o)) : ""),
        html: (o) => (u(o) ? live(o, memText(o), u(o)!.mem, memT(o), trend.get(o.metadata.name)?.mem ?? []) : "") },
    ];
  };

  function skeletonRows(cols: Col[]): string {
    const w = [
      [65, 45, 30, 45, 25, 55, 45, 35],
      [50, 35, 30, 40, 20, 60, 40, 30],
      [75, 50, 30, 45, 25, 45, 45, 35],
      [55, 40, 30, 35, 20, 50, 40, 30],
      [70, 35, 30, 40, 25, 55, 45, 35],
      [60, 45, 30, 35, 20, 40, 40, 30],
    ];
    return w.map((row) =>
      `<tr class="skeleton-row">${cols.map((_, i) =>
        `<td><span class="skeleton-cell" style="width:${row[i % row.length]}%"></span></td>`
      ).join("")}</tr>`
    ).join("");
  }

  function render() {
    histBar.hidden = kind.source !== "history";
    const base = kind.namespaced && currentNs() ? kind.cols.filter((c) => c !== ns) : kind.cols;
    // metrics go right before the age column
    const mc = metricCols();
    const cols = mc.length ? [...base.slice(0, -1), ...mc, base[base.length - 1]] : base;
    if (sortCol >= cols.length) sortCol = 0;
    thead.innerHTML = `<tr>${cols.map((c, i) => `<th data-i="${i}" class="${i === sortCol ? (sortDir > 0 ? "asc" : "desc") : ""}">${esc(c.h)}</th>`).join("")}</tr>`;
    if (items.length === 0 && root.classList.contains("loading")) {
      tbody.innerHTML = skeletonRows(cols);
      countEl.textContent = "";
      openPending();
      syncDetails();
      return;
    }
    const q = filterIn.value.trim().toLowerCase();
    let sel: Term[] = [];
    try {
      sel = parseSelector(lfilterIn.value);
      lfilterIn.classList.remove("bad");
      lfilterIn.removeAttribute("aria-invalid");
    } catch (e) {
      lfilterIn.classList.add("bad");
      lfilterIn.setAttribute("aria-invalid", "true");
      lfilterIn.dataset.err = (e as Error).message;
    }
    const rows = items.filter((o) => !sel.length || matches(sel, o.metadata?.labels))
      .map((o) => ({ o, cells: cols.map((c) => String(c.v(o))) }))
      .filter((r) => !q || r.cells.join(" ").toLowerCase().includes(q));
    const sc = cols[sortCol];
    const sv = (o: Obj) => (sc.sort ?? sc.v)(o);
    rows.sort((a, b) => {
      const x = sv(a.o), y = sv(b.o);
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sortDir;
    });
    tbody.innerHTML = rows.map(({ o, cells }) => {
      const k = keyOf(o);
      return `<tr data-key="${esc(k)}" class="${k === selected ? "sel" : ""}">${cells.map((v, i) => `<td class="${cols[i].cls?.(o) ?? ""}">${cols[i].html ? cols[i].html!(o) : esc(v)}</td>`).join("")}</tr>`;
    }).join("");
    countEl.textContent = ctx ? `${rows.length}${rows.length !== items.length ? ` из ${items.length}` : ""}` : "";
    openPending();
    syncDetails();
  }

  thead.onclick = (e) => {
    const th = (e.target as HTMLElement).closest("th");
    if (!th) return;
    const i = Number(th.dataset.i);
    sortDir = i === sortCol ? -sortDir : 1;
    sortCol = i;
    render();
  };
  tbody.onclick = (e) => {
    const tr = (e.target as HTMLElement).closest("tr");
    const o = tr && items.find((x) => keyOf(x) === tr.dataset.key);
    if (o) openDrawer(o);
  };
  filterIn.oninput = render;
  lfilterIn.oninput = render;
  lfilterIn.onblur = () => { if (lfilterIn.classList.contains("bad")) toast(t(lfilterIn.dataset.err ?? ""), "err"); };

  // ----- drawer -----

  function closeDrawer() {
    drawerCleanup?.();
    drawerCleanup = null;
    drawer.hidden = true;
    selected = null;
    tbody.querySelectorAll("tr.sel").forEach((r) => r.classList.remove("sel"));
  }

  function openDrawer(o: Obj) {
    drawerCleanup?.();
    drawerCleanup = null;
    selected = keyOf(o);
    tbody.querySelectorAll("tr").forEach((r) => r.classList.toggle("sel", r.dataset.key === selected));
    drawer.hidden = false;
    const objNs: string = o.metadata.namespace ?? "";
    $(".obj-title").textContent = `${kind.label.replace(/s$/, "")} ${objNs ? objNs + "/" : ""}${o.metadata.name}`;

    if (kind.source === "history") {
      // a recorded event: its text and where it came from; the object itself may be long gone
      $(".obj-title").textContent = `${o.involvedObject?.kind ?? ""} ${objNs ? objNs + "/" : ""}${o.involvedObject?.name ?? ""}`;
      $(".drawer-tabs").innerHTML = "";
      drawerBody.innerHTML = `<div class="hist-detail">
        <div><b class="${o.type === "Warning" ? "warn" : "muted"}">${esc(o.type ?? "")}</b> · ${esc(o.reason ?? "")} · ×${esc(String(o.count ?? 1))}</div>
        <div class="muted">${esc(t("впервые"))}: ${esc(new Date(o.firstTimestamp).toLocaleString(locale()))} · ${esc(t("последний раз"))}: ${esc(new Date(o.lastTimestamp).toLocaleString(locale()))}</div>
        <pre class="ro-text">${esc(o.message ?? "")}</pre></div>`;
      const actions = $(".drawer-actions");
      actions.innerHTML = "";
      const ai = document.createElement("button");
      ai.className = "ghost";
      ai.textContent = "⇢ AI";
      ai.onclick = () => window.dispatchEvent(new CustomEvent("send-to-ai", { detail: `Событие Kubernetes (${ctx?.context}): ${o.type} ${o.reason} ×${o.count ?? 1} у ${o.involvedObject?.kind}/${o.involvedObject?.name} в ${objNs || "кластере"}, с ${o.firstTimestamp} по ${o.lastTimestamp}:\n${o.message ?? ""}` }));
      actions.appendChild(ai);
      return;
    }
    const tabs: [string, () => void][] = kind.source === "helm"
      ? [["Values", () => showHelm(o, "values")], ["История", () => showHelm(o, "history")], ["Manifest", () => showHelm(o, "manifest")], ["Notes", () => showHelm(o, "notes")]]
      : [["YAML", () => showYaml(o)]];
    if (kind.id === "pods") tabs.unshift(["Логи", () => showLogs(o)]);
    if (["deployments", "statefulsets", "daemonsets", "replicasets", "jobs"].includes(kind.id)) tabs.unshift(["Логи", () => showWorkloadLogs(o)]);
    if (kind.source !== "helm") tabs.unshift(["Детали", () => showDetails(o)]);
    if (kind.id === "applications") tabs.unshift(["Ресурсы", () => showArgoResources(o)]);
    const tabsEl = $(".drawer-tabs");
    tabsEl.innerHTML = "";
    tabs.forEach(([label, fn], i) => {
      const b = document.createElement("button");
      b.className = "dtab";
      b.textContent = label;
      b.onclick = () => {
        drawerCleanup?.();
        drawerCleanup = null;
        tabsEl.querySelectorAll(".dtab").forEach((x) => x.classList.toggle("active", x === b));
        fn();
      };
      tabsEl.appendChild(b);
      if (i === 0) b.click();
    });

    const actions = $(".drawer-actions");
    actions.innerHTML = "";
    const act = (label: string, fn: () => void, cls = "ghost") => {
      const b = document.createElement("button");
      b.className = cls;
      b.textContent = label;
      b.onclick = fn;
      actions.appendChild(b);
    };
    const ro = isReadonly();
    if (kind.id === "pods" && !ro) {
      act("Shell", () => execShell(o));
    }
    if (kind.id === "pods") act("Port-forward", () => portForward(o, "pod"));
    if (kind.id === "services") act("Port-forward", () => portForward(o, "svc"));
    if (kind.id === "applications" && !ro) {
      act("Refresh", () => argo(o, "refresh"));
      act("Sync", () => argo(o, "sync"));
    }
    if (kind.source === "helm") {
      if (!ro) {
        act("Rollback", () => helmRollback(o));
        act("Uninstall", () => helmUninstall(o), "ghost danger");
      }
      return;
    }
    if (!ro) {
      if (["deployments", "statefulsets", "replicasets"].includes(kind.id)) act("Scale", () => scale(o));
      if (["deployments", "statefulsets", "daemonsets"].includes(kind.id)) act("Restart", () => restart(o));
      act("Удалить", () => del(o), "ghost danger");
    }
  }

  type HelmDetail = { values: string; manifest: string; notes: string | null; history: Obj[] };
  let helmCache: { key: string; data: HelmDetail } | null = null;
  async function showHelm(o: Obj, tab: "values" | "history" | "manifest" | "notes") {
    drawerBody.innerHTML = `<div class="yaml-pane"><pre class="ro-text">загрузка…</pre></div>`;
    const pre = drawerBody.querySelector<HTMLElement>("pre")!;
    const key = `${o.metadata.namespace}/${o.metadata.name}/${o.revision}`;
    try {
      if (helmCache?.key !== key) {
        helmCache = { key, data: await invoke<HelmDetail>("k8s_helm_release", { ctx: ref(), namespace: o.metadata.namespace, name: o.metadata.name }) };
      }
      const d = helmCache.data;
      if (tab === "history") {
        drawerBody.innerHTML = `<div class="table-wrap"><table class="res"><thead><tr><th>Ревизия</th><th>Статус</th><th>Chart</th><th>App</th><th>Когда</th><th>Описание</th></tr></thead><tbody>${
          d.history.map((h) => `<tr><td>${esc(h.revision)}</td><td class="${helmStatusCls(h.status)}">${esc(h.status)}</td><td>${esc(h.chart)}</td><td>${esc(h.app_version ?? "")}</td><td>${esc(age(h.updated))}</td><td class="wrap muted">${esc(h.description ?? "")}</td></tr>`).join("")
        }</tbody></table></div>`;
        return;
      }
      pre.textContent = (tab === "values" ? d.values : tab === "manifest" ? d.manifest : d.notes) || t("(пусто)");
    } catch (e) { pre.textContent = String(e); }
  }

  async function helmRollback(o: Obj) {
    const prev = Math.max(1, Number(o.revision) - 1);
    const rev = await ask("Helm rollback", `${o.metadata.namespace}/${o.metadata.name} (${ctx!.context}): на какую ревизию откатить? Текущая — ${o.revision}.`, { input: String(prev), ok: "Откатить" });
    if (!rev || !/^\d+$/.test(rev)) return;
    kubectlTab(`helm rollback ${o.metadata.name}`, ["rollback", o.metadata.name, rev, "-n", o.metadata.namespace], undefined, "helm");
  }

  async function helmUninstall(o: Obj) {
    const v = await ask("Helm uninstall", `Удалить релиз ${o.metadata.namespace}/${o.metadata.name} в контексте ${ctx!.context} вместе со всеми его ресурсами? Для подтверждения введите имя релиза.`,
      { input: "", placeholder: o.metadata.name, ok: "Удалить", danger: true });
    if (v === null) return;
    if (v !== o.metadata.name) return toast("Имя не совпало — ничего не удалено", "err");
    kubectlTab(`helm uninstall ${o.metadata.name}`, ["uninstall", o.metadata.name, "-n", o.metadata.namespace], undefined, "helm");
  }

  // ----- details (re-rendered when the watch delivers a newer version of the object) -----

  let detailsKey: string | null = null;
  let detailsVersion = "";
  let detailsEvents: Obj[] | null = null;
  let eventsAt = 0;

  function showDetails(o: Obj) {
    detailsKey = keyOf(o);
    detailsVersion = "";
    detailsEvents = null;
    drawerCleanup = () => { detailsKey = null; };
    renderDetails(o);
    loadEvents(o);
  }

  async function loadEvents(o: Obj) {
    eventsAt = Date.now();
    const key = keyOf(o);
    const ev = await invoke<Obj[]>("k8s_object_events", { ctx: ref(), namespace: o.metadata.namespace ?? null, uid: o.metadata.uid }).catch(() => [] as Obj[]);
    if (detailsKey !== key) return;
    detailsEvents = ev;
    detailsVersion = "";
    renderDetails(items.find((x) => keyOf(x) === key) ?? o);
  }

  function renderDetails(o: Obj) {
    const version = `${o.metadata.resourceVersion}|${detailsEvents?.length ?? -1}`;
    if (version === detailsVersion) return;
    detailsVersion = version;
    const scroll = drawerBody.querySelector(".details")?.scrollTop ?? 0;
    drawerBody.innerHTML = detailsHtml(kind.id, o, detailsEvents);
    const el = drawerBody.querySelector<HTMLElement>(".details")!;
    el.scrollTop = scroll;
    el.onclick = (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>(".dlink");
      if (a) return navigateTo(a.dataset.kind!, a.dataset.ns ?? "", a.dataset.name!);
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-secret]");
      if (!btn) return;
      // the value goes under its key on the full width of the table (a narrow cell broke long values into a column of letters)
      const tr = btn.closest("tr")!;
      if (tr.nextElementSibling?.classList.contains("secret-row")) {
        tr.nextElementSibling.remove();
        btn.textContent = "показать";
        return;
      }
      const v = decodeSecret(o.data[btn.dataset.secret!]);
      const row = document.createElement("tr");
      row.className = "secret-row";
      const td = row.appendChild(document.createElement("td"));
      td.colSpan = 3;
      if (v.binary) {
        const note = td.appendChild(document.createElement("div"));
        note.className = "muted secret-note";
        note.textContent = v.size ? `Бинарные данные, ${v.size} байт — base64:` : "Не base64 — значение как есть:";
      }
      const code = td.appendChild(document.createElement("pre"));
      code.className = "secret-value";
      code.textContent = v.text;
      tr.after(row);
      btn.textContent = "скрыть";
      detailsVersion = "pinned"; // keep the revealed value until the object actually changes
    };
  }

  /** Jump to another object: switch the resource table (and namespace if needed), then open it. */
  let pendingOpen: { ns: string; name: string } | null = null;
  function navigateTo(kindName: string, ns: string, name: string) {
    const target = allKinds().find((k) => k.id === kindName);
    if (!target) return toast(`Нет таблицы для ${kindName}`, "err");
    pendingOpen = { ns: target.namespaced ? ns : "", name };
    let nsChanged = false;
    if (target.namespaced && nsSel.value && nsSel.value !== ns) {
      nsSel.value = [...nsSel.options].some((o) => o.value === ns) ? ns : "";
      store.set(`ns:${ctx!.file}|${ctx!.context}`, nsSel.value);
      nsChanged = true;
    }
    if (target === kind) {
      if (nsChanged) { closeDrawer(); startWatch(); } else openPending();
      return;
    }
    selectKind(target);
  }
  function openPending() {
    if (!pendingOpen) return;
    const o = items.find((x) => x.metadata.name === pendingOpen!.name && (x.metadata.namespace ?? "") === pendingOpen!.ns);
    if (!o) return;
    pendingOpen = null;
    openDrawer(o);
    tbody.querySelector("tr.sel")?.scrollIntoView({ block: "nearest" });
  }

  /** Called from render(): refresh the open details panel from the live list. */
  function syncDetails() {
    if (!detailsKey || drawer.hidden) return;
    const o = items.find((x) => keyOf(x) === detailsKey);
    if (!o) return;
    if (detailsVersion === "pinned" && o.metadata.resourceVersion === drawerBody.dataset.rv) return;
    drawerBody.dataset.rv = o.metadata.resourceVersion;
    renderDetails(o);
    if (Date.now() - eventsAt > 20000) loadEvents(o);
  }

  function showArgoResources(o: Obj) {
    const res: Obj[] = o.status?.resources ?? [];
    const cls = (s?: string) => ({ Synced: "ok", OutOfSync: "warn", Healthy: "ok", Progressing: "warn", Degraded: "bad", Missing: "bad" } as Record<string, string>)[s ?? ""] ?? "muted";
    drawerBody.innerHTML = `<div class="table-wrap"><table class="res"><thead><tr><th>Kind</th><th>Namespace</th><th>Имя</th><th>Sync</th><th>Health</th></tr></thead><tbody>${
      res.map((r) => `<tr><td>${esc(r.kind)}</td><td>${esc(r.namespace ?? "")}</td><td>${esc(r.name)}</td><td class="${cls(r.status)}">${esc(r.status ?? "")}</td><td class="${cls(r.health?.status)}">${esc(r.health?.status ?? "")}</td></tr>`).join("")
      || `<tr><td class="muted">Нет данных о ресурсах</td></tr>`
    }</tbody></table></div>`;
  }

  async function argo(o: Obj, action: "refresh" | "sync") {
    if (action === "sync" && (await ask("Argo CD sync", `Синхронизировать ${o.metadata.name} (${ctx!.context})? Будет применено состояние из ${argoSrc(o).repoURL ?? "репозитория"}.`, { ok: "Sync" })) === null) return;
    invoke("k8s_argo_action", { ctx: ref(), namespace: o.metadata.namespace, name: o.metadata.name, action })
      .then(() => toast(action === "sync" ? `Sync запущен: ${o.metadata.name}` : `Refresh: ${o.metadata.name}`), (e) => toast(String(e), "err"));
  }

  async function showYaml(o: Obj) {
    drawerBody.innerHTML = `<div class="yaml-pane"><textarea spellcheck="false" class="yaml">загрузка…</textarea>
      <div class="yaml-actions"><span class="err yaml-err"></span><span class="spacer"></span>
      <button class="ghost" data-y="reload">Перечитать</button><button class="primary" data-y="apply" ${isReadonly() ? "disabled title=\"Контекст в режиме только чтения\"" : ""}>Применить</button></div></div>`;
    const ta = drawerBody.querySelector<HTMLTextAreaElement>("textarea")!;
    const errEl = drawerBody.querySelector<HTMLElement>(".yaml-err")!;
    const load = async () => {
      errEl.textContent = "";
      try {
        ta.value = await invoke<string>("k8s_get_yaml", { ctx: ref(), kind: kind.id, namespace: o.metadata.namespace ?? null, name: o.metadata.name });
      } catch (e) { errEl.textContent = String(e); }
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Tab") { e.preventDefault(); ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end"); }
    });
    drawerBody.querySelector<HTMLElement>("[data-y=reload]")!.onclick = load;
    drawerBody.querySelector<HTMLElement>("[data-y=apply]")!.onclick = async () => {
      if ((await ask("Применить изменения", `Применить YAML к ${o.metadata.name} в контексте ${ctx!.context}?`, { ok: "Применить" })) === null) return;
      try {
        await invoke("k8s_apply_yaml", { ctx: ref(), kind: kind.id, namespace: o.metadata.namespace ?? null, yaml: ta.value });
        toast("Применено");
        await load();
        refresh();
      } catch (e) { errEl.textContent = String(e); }
    };
    await load();
  }

  function showLogs(o: Obj) {
    const containers: string[] = [...(o.spec.initContainers ?? []), ...o.spec.containers].map((c: Obj) => c.name);
    drawerBody.innerHTML = `<div class="logs-pane">
      <div class="logs-bar">
        <select class="lc">${containers.map((c) => `<option ${c === o.spec.containers[0].name ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
        <select class="lt"><option value="100">100 строк</option><option value="500" selected>500 строк</option><option value="2000">2000 строк</option><option value="10000">10000 строк</option></select>
        <label class="muted"><input type="checkbox" class="lp" /> previous</label>
        <label class="muted"><input type="checkbox" class="lts" /> время</label>
        <input class="lf" placeholder="фильтр…" spellcheck="false" />
        <span class="spacer"></span>
        <span class="lstate muted"></span>
        <button class="ghost" data-l="ai" title="Отправить выделение (или последние 150 строк) в AI-панель">⇢ в AI</button>
        <button class="ghost" data-l="clear">Очистить</button>
      </div>
      <div class="logs-term"></div></div>`;
    const q = <T extends HTMLElement>(s: string) => drawerBody.querySelector<T>(s)!;
    const term = new Terminal({ fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: 12, scrollback: 50000,
      convertEol: true, disableStdin: true, theme: { background: "#0f1117", foreground: "#d6deeb", selectionBackground: "#2b3a55" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(q(".logs-term"));
    const ro = new ResizeObserver(() => { if (q<HTMLElement>(".logs-term").clientWidth) fit.fit(); });
    ro.observe(q(".logs-term"));

    const id = `log${Date.now()}`;
    let unlisten: UnlistenFn[] = [];
    const state = q(".lstate");
    const view = new LogView(term);
    const stop = () => { invoke("k8s_logs_stop", { id }); unlisten.forEach((u) => u()); unlisten = []; };
    let ft = 0;
    q<HTMLInputElement>(".lf").oninput = () => { clearTimeout(ft); ft = window.setTimeout(() => view.setFilter(q<HTMLInputElement>(".lf").value), 150); };

    const start = async () => {
      stop();
      view.clear();
      state.textContent = "подключение…";
      unlisten = [
        await listen<string[]>(`k8s-log-${id}`, (e) => { view.add(e.payload.map((text) => ({ text }))); state.textContent = "● live"; }),
        await listen<string | null>(`k8s-log-end-${id}`, (e) => { state.textContent = e.payload ? `ошибка: ${e.payload}` : "поток завершён"; }),
      ];
      try {
        await invoke("k8s_logs_start", { ctx: ref(), id, req: {
          namespace: o.metadata.namespace, pod: o.metadata.name, container: q<HTMLSelectElement>(".lc").value,
          tail: Number(q<HTMLSelectElement>(".lt").value), previous: q<HTMLInputElement>(".lp").checked,
          timestamps: q<HTMLInputElement>(".lts").checked } });
      } catch (e) {
        state.textContent = "";
        term.write(`\x1b[31m${String(e)}\x1b[0m\n`);
      }
    };
    [".lc", ".lt", ".lp", ".lts"].forEach((s) => q(s).addEventListener("change", start));
    q<HTMLElement>("[data-l=clear]").onclick = () => view.clear();
    q<HTMLElement>("[data-l=ai]").onclick = () => {
      const text = view.tail();
      if (text) window.dispatchEvent(new CustomEvent("send-to-ai", { detail: `Логи пода ${o.metadata.namespace}/${o.metadata.name} (${ctx!.context}):\n${text}` }));
    };
    drawerCleanup = () => { stop(); ro.disconnect(); term.dispose(); };
    requestAnimationFrame(() => { fit.fit(); start(); });
  }

  /** Logs of every pod of a Deployment/StatefulSet/DaemonSet/ReplicaSet/Job, merged, one color per pod. */
  function showWorkloadLogs(o: Obj) {
    const containers: string[] = (o.spec?.template?.spec?.containers ?? []).map((c: Obj) => c.name);
    drawerBody.innerHTML = `<div class="logs-pane">
      <div class="logs-bar">
        <select class="lc"><option value="">все контейнеры</option>${containers.map((c) => `<option>${esc(c)}</option>`).join("")}</select>
        <select class="lt"><option value="50">50 строк на под</option><option value="200" selected>200 строк на под</option><option value="1000">1000 строк на под</option></select>
        <label class="muted"><input type="checkbox" class="lts" /> время</label>
        <select class="lpod"><option value="">все поды</option></select>
        <input class="lf" placeholder="фильтр…" spellcheck="false" />
        <span class="spacer"></span>
        <span class="lstate muted"></span>
        <button class="ghost" data-l="ai" title="Отправить выделение (или последние 150 строк) в AI-панель">⇢ в AI</button>
        <button class="ghost" data-l="clear">Очистить</button>
      </div>
      <div class="logs-term"></div></div>`;
    const q = <T extends HTMLElement>(s: string) => drawerBody.querySelector<T>(s)!;
    const term = new Terminal({ fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: 12, scrollback: 50000,
      convertEol: true, disableStdin: true, theme: { background: "#0f1117", foreground: "#d6deeb", selectionBackground: "#2b3a55" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(q(".logs-term"));
    const ro = new ResizeObserver(() => { if (q<HTMLElement>(".logs-term").clientWidth) fit.fit(); });
    ro.observe(q(".logs-term"));

    const id = `wlog${Date.now()}`;
    const view = new LogView(term);
    const state = q(".lstate"), podSel = q<HTMLSelectElement>(".lpod"), filter = q<HTMLInputElement>(".lf");
    let unlisten: UnlistenFn[] = [];
    // pod names share the workload prefix: show only the distinguishing tail
    const short = (pod: string) => pod.startsWith(o.metadata.name + "-") ? pod.slice(o.metadata.name.length + 1) : pod;
    let width = 8;
    const stop = () => { invoke("k8s_logs_stop", { id }); unlisten.forEach((u) => u()); unlisten = []; };
    const applyFilter = () => view.setFilter(filter.value, podSel.value);

    const start = async () => {
      stop();
      view.clear();
      state.textContent = "ищу поды…";
      const showContainer = !q<HTMLSelectElement>(".lc").value && containers.length > 1;
      unlisten = [
        await listen<{ pod: string; container: string; line: string }[]>(`k8s-log-${id}`, (e) => {
          view.add(e.payload.map((l) => {
            const tag = showContainer ? `${short(l.pod)}/${l.container}` : short(l.pod);
            width = Math.max(width, tag.length);
            return { pod: l.pod, text: `\x1b[${podColor(l.pod)}m${tag.padEnd(width)}\x1b[0m \x1b[2m│\x1b[0m ${l.line}` };
          }));
        }),
        await listen<string[]>(`k8s-log-pods-${id}`, (e) => {
          const pods = e.payload;
          state.textContent = pods.length ? `● ${pods.length} ${pods.length === 1 ? "под" : pods.length < 5 ? "пода" : "подов"}` : "подов нет";
          state.title = pods.join("\n") + (pods.length > 40 ? "\n(логи читаются с первых 40)" : "");
          const cur = podSel.value;
          podSel.innerHTML = `<option value="">все поды</option>` + pods.map((p) => `<option value="${esc(p)}">${esc(short(p))}</option>`).join("");
          podSel.value = pods.includes(cur) ? cur : "";
        }),
      ];
      try {
        await invoke("k8s_logs_workload_start", { ctx: ref(), id, req: {
          kind: kind.id, namespace: o.metadata.namespace, name: o.metadata.name,
          container: q<HTMLSelectElement>(".lc").value || null, tail: Number(q<HTMLSelectElement>(".lt").value),
          timestamps: q<HTMLInputElement>(".lts").checked } });
      } catch (e) {
        state.textContent = "";
        term.write(`\x1b[31m${String(e)}\x1b[0m\n`);
      }
    };
    [".lc", ".lt", ".lts"].forEach((sel) => q(sel).addEventListener("change", start));
    podSel.onchange = applyFilter;
    let ft = 0;
    filter.oninput = () => { clearTimeout(ft); ft = window.setTimeout(applyFilter, 150); };
    q<HTMLElement>("[data-l=clear]").onclick = () => view.clear();
    q<HTMLElement>("[data-l=ai]").onclick = () => {
      const text = view.tail();
      if (text) window.dispatchEvent(new CustomEvent("send-to-ai", { detail: `Логи ${kind.label} ${o.metadata.namespace}/${o.metadata.name}, все поды (${ctx!.context}):\n${text}` }));
    };
    drawerCleanup = () => { stop(); ro.disconnect(); term.dispose(); };
    requestAnimationFrame(() => { fit.fit(); start(); });
  }

  // ----- actions -----

  async function kubectlTab(title: string, args: string[], nsForShell?: string, program = "kubectl") {
    try {
      const path = await invoke<string>("k8s_shell_config", { ctx: ref(), namespace: nsForShell ?? null });
      const detail: OpenTerminalDetail = args.length
        ? { title, program, args, env: { KUBECONFIG: path }, keepOpen: true }
        : { title, env: { KUBECONFIG: path } };
      window.dispatchEvent(new CustomEvent("open-terminal", { detail }));
    } catch (e) { toast(String(e), "err"); }
  }

  function execShell(o: Obj) {
    const c = o.spec.containers.length > 1 ? drawerBody.querySelector<HTMLSelectElement>(".lc")?.value ?? o.spec.containers[0].name : o.spec.containers[0].name;
    kubectlTab(`⎈ ${o.metadata.name}`, ["exec", "-it", "-n", o.metadata.namespace, o.metadata.name, "-c", c, "--",
      "sh", "-c", "command -v bash >/dev/null && exec bash || exec sh"]);
  }

  async function portForward(o: Obj, type: "pod" | "svc") {
    const port = type === "svc" ? o.spec.ports?.[0]?.port : o.spec.containers.flatMap((c: Obj) => c.ports ?? [])[0]?.containerPort;
    const spec = await ask("Port-forward", `${type}/${o.metadata.name} → localhost. Формат: локальный:удалённый`, { input: port ? `${port}:${port}` : "8080:80", ok: "Запустить" });
    if (!spec || !/^\d+(:\d+)?$/.test(spec)) return;
    kubectlTab(`⇄ ${o.metadata.name} ${spec}`, ["port-forward", "-n", o.metadata.namespace, `${type}/${o.metadata.name}`, spec]);
  }

  async function scale(o: Obj) {
    const v = await ask("Scale", `${o.metadata.namespace}/${o.metadata.name} (${ctx!.context}): число реплик`, { input: String(o.spec.replicas ?? 1), ok: "Применить" });
    if (v === null || !/^\d+$/.test(v)) return;
    invoke("k8s_scale", { ctx: ref(), kind: kind.id, namespace: o.metadata.namespace, name: o.metadata.name, replicas: Number(v) })
      .then(() => { toast(`Scale → ${v}`); refresh(); }, (e) => toast(String(e), "err"));
  }

  async function restart(o: Obj) {
    if ((await ask("Rollout restart", `Перезапустить ${o.metadata.namespace}/${o.metadata.name} в контексте ${ctx!.context}?`, { ok: "Перезапустить" })) === null) return;
    invoke("k8s_restart", { ctx: ref(), kind: kind.id, namespace: o.metadata.namespace, name: o.metadata.name })
      .then(() => { toast("Restart запущен"); refresh(); }, (e) => toast(String(e), "err"));
  }

  async function del(o: Obj) {
    const full = `${o.metadata.namespace ? o.metadata.namespace + "/" : ""}${o.metadata.name}`;
    // already being deleted and stuck (usually its node is offline): plain delete won't help
    const since = o.metadata.deletionTimestamp as string | undefined;
    if (since && kind.id === "pods") {
      const mins = Math.round((Date.now() - new Date(since).getTime()) / 60000);
      const node = o.spec?.nodeName ? `узел ${o.spec.nodeName}` : "узел";
      const v = await ask("Под завис в Terminating",
        `${full} удаляется уже ${mins < 120 ? `${mins} мин` : `${Math.round(mins / 60)} ч`}: ${node} не подтверждает остановку — обычно он выключен или не на связи. ` +
        `Можно удалить принудительно (как kubectl delete --grace-period=0 --force): объект исчезнет сразу, но если узел вернётся, контейнер может ещё поработать, пока kubelet его не уберёт. ` +
        `Для подтверждения введите имя пода.`,
        { input: "", placeholder: o.metadata.name, ok: "Удалить принудительно", danger: true });
      if (v !== o.metadata.name) { if (v !== null) toast("Имя не совпало — ничего не удалено", "err"); return; }
      invoke("k8s_delete", { ctx: ref(), kind: kind.id, namespace: o.metadata.namespace ?? null, name: o.metadata.name, force: true })
        .then(() => { toast(`Удалено принудительно: ${full}`); closeDrawer(); refresh(); }, (e) => toast(String(e), "err"));
      return;
    }
    const v = await ask("Удаление", `Удалить ${kind.label.replace(/s$/, "")} ${full} в контексте ${ctx!.context}? Для подтверждения введите имя объекта.`,
      { input: "", placeholder: o.metadata.name, ok: "Удалить", danger: true });
    if (v !== o.metadata.name) { if (v !== null) toast("Имя не совпало — ничего не удалено", "err"); return; }
    invoke("k8s_delete", { ctx: ref(), kind: kind.id, namespace: o.metadata.namespace ?? null, name: o.metadata.name, force: false })
      .then(() => {
        toast(kind.id === "pods" ? `Удаление запущено: ${full}` : `Удалено: ${full}`);
        closeDrawer();
        refresh();
      }, (e) => toast(String(e), "err"));
  }

  // ----- import -----

  type ImportResult = { count: number; exec: string[] };
  /** kubeconfigs can run programs to fetch credentials: make that visible for imported files. */
  function warnExec(cmds: string[]) {
    if (!cmds.length) return;
    ask("Kubeconfig запускает команды",
      `При подключении к этому кластеру будет выполнено: ${cmds.join(" ; ")}. Так работают aws/gcloud/kubelogin и т.п. ` +
      `Если файл получен не из доверенного источника — удалите контекст и не подключайтесь.`, { ok: "Понятно" });
  }

  const dialog = $<HTMLDialogElement>(".import-dialog");
  const dform = dialog.querySelector("form")!;
  const sysList = dialog.querySelector<HTMLElement>(".sys-list")!;
  let sysCtx: CtxInfo[] = [];
  async function openImport() {
    dform.reset();
    dform.querySelector<HTMLElement>(".form-err")!.textContent = "";
    dialog.showModal();
    sysCtx = await invoke<CtxInfo[]>("k8s_system_contexts").catch(() => []);
    // already copied = same context name and API server in OpsDeck's store
    const have = new Set(contexts.filter((c) => c.source === "opsdeck").map((c) => `${c.context}|${c.server}`));
    sysList.innerHTML = sysCtx.length ? sysCtx.map((c, i) => {
      const dup = have.has(`${c.context}|${c.server}`);
      return `<label class="sys-item"><input type="checkbox" data-i="${i}" ${dup ? "disabled" : ""} />
        <span class="ctx-name">${esc(c.context)}</span><span class="muted">${esc(c.server.replace(/^https?:\/\//, ""))}</span>
        ${dup ? `<span class="badge">уже есть</span>` : ""}</label>`;
    }).join("") : `<p class="muted">В ~/.kube/config контекстов нет.</p>`;
  }
  $("[data-act=import]").onclick = openImport;
  dform.addEventListener("submit", async (e) => {
    const act = (e.submitter as HTMLButtonElement | null)?.value;
    if (act === "sys") {
      e.preventDefault();
      const chosen = [...sysList.querySelectorAll<HTMLInputElement>("input:checked")].map((cb) => sysCtx[Number(cb.dataset.i)]);
      if (!chosen.length) { dform.querySelector<HTMLElement>(".form-err")!.textContent = "Отметьте хотя бы один контекст"; return; }
      try {
        const byFile = new Map<string, string[]>();
        chosen.forEach((c) => byFile.set(c.file, [...(byFile.get(c.file) ?? []), c.context]));
        for (const [file, names] of byFile) await invoke("k8s_import_contexts", { file, contexts: names });
        dialog.close();
        toast(`Скопировано в OpsDeck: ${chosen.map((c) => c.context).join(", ")}`);
        loadContexts();
      } catch (err) { dform.querySelector<HTMLElement>(".form-err")!.textContent = String(err); }
      return;
    }
    if (act !== "ok") return;
    e.preventDefault();
    const f = (n: string) => (dform.elements.namedItem(n) as HTMLInputElement).value;
    try {
      const r = await invoke<ImportResult>("k8s_import", { name: f("name") || null, yaml: f("yaml"), path: null });
      dialog.close();
      toast(`Импортировано контекстов: ${r.count}`);
      warnExec(r.exec);
      loadContexts();
    } catch (err) { dform.querySelector<HTMLElement>(".form-err")!.textContent = String(err); }
  });

  getCurrentWebview().onDragDropEvent(async (e) => {
    if (root.hidden) return;
    root.classList.toggle("dragover", e.payload.type === "over" || e.payload.type === "enter");
    if (e.payload.type !== "drop") return;
    root.classList.remove("dragover");
    for (const path of e.payload.paths) {
      try {
        const r = await invoke<ImportResult>("k8s_import", { name: null, yaml: null, path });
        toast(`${path.split("/").pop()}: контекстов ${r.count}`);
        warnExec(r.exec);
      } catch (err) { toast(`${path.split("/").pop()}: ${err}`, "err"); }
    }
    loadContexts();
  });

  // ----- toolbar / timers -----

  $("[data-act=refresh]").onclick = () => { startWatch(); loadMetrics(); };
  $("[data-act=close-drawer]").onclick = closeDrawer;
  $("[data-act=shell]").onclick = () => ctx && kubectlTab(`⎈ ${ctx.context}${nsSel.value ? "/" + nsSel.value : ""}`, [], nsSel.value || undefined);
  autoCb.checked = store.get("auto") !== "0";
  autoCb.onchange = () => { store.set("auto", autoCb.checked ? "1" : "0"); startWatch(); };

  // Helm has no watch API: poll it; metrics are sampled by metrics-server every ~15 s anyway
  setInterval(() => {
    if (!root.hidden && autoCb.checked && !document.hidden && (kind.source === "helm" || kind.source === "history")) refresh();
  }, 30000);
  // only while the view is open: an unreachable cluster shouldn't be hammered in the background
  // nodes: every 5 s (live view); pods: every 15 s
  let metricTick = 0;
  setInterval(() => { if (!document.hidden && !root.hidden && (kind.id === "nodes" || ++metricTick % 3 === 0)) loadMetrics(); }, 5000);
  window.addEventListener("view-shown", (e) => {
    // leaving the view: stop the live watch (it resumes on return), no reconnect loop in the background
    if ((e as CustomEvent).detail !== "k8s") { stopWatch(); return; }
    loadContexts();
    if (ctx && !watchId && !kind.source) startWatch();
    render();
    loadMetrics();
  });

  registerProvider(() => {
    const go = () => window.dispatchEvent(new CustomEvent("show-view", { detail: "k8s" }));
    const visible = contexts.filter((c) => !prefs.hidden.includes(ctxKey(c)));
    return [
      ...visible.map((c) => ({ group: "Kubernetes", title: `Контекст: ${c.context}`, hint: c.server, run: () => { go(); selectContext(c); } })),
      ...allKinds().map((k) => ({ group: "Kubernetes", title: `Ресурсы: ${k.label}`, hint: k.crd ? k.group : ctx?.context, run: () => { go(); selectKind(k); } })),
      ...(ctx && !isReadonly() ? [{ group: "Kubernetes", title: `Терминал kubectl: ${ctx.context}`, run: () => $("[data-act=shell]").click() }] : []),
    ];
  });

  window.addEventListener("settings-changed", () => loadContexts());

  renderKinds();
  render();
  loadContexts();
}
