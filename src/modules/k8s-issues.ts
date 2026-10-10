/**
 * Kubernetes diagnostics computed from objects already readable with the user's kubeconfig, nothing is
 * installed in the cluster:
 *  - findProblems: what is broken right now (crashing pods, rollouts that do not finish, pods that cannot be
 *    scheduled, references to objects that do not exist, services without endpoints, ingresses to nowhere);
 *  - runChecks: best practices of workload templates (security, reliability, efficiency), each with a fix.
 * Pure functions over plain JSON objects (as `kubectl get -o json` returns them), so they are unit-tested.
 */
type Obj = any;

export type Snapshot = {
  pods: Obj[]; deployments: Obj[]; statefulsets: Obj[]; daemonsets: Obj[]; jobs: Obj[]; cronjobs: Obj[];
  services: Obj[]; endpointslices: Obj[]; ingresses: Obj[]; pvcs: Obj[]; pdbs: Obj[];
  /** names only (the backend never sends Secret data here) */
  configmaps: { namespace: string; name: string }[]; secrets: { namespace: string; name: string }[];
  serviceaccounts?: { namespace: string; name: string }[];
  /** when the snapshot was taken (ms) — for "stuck for N minutes" */
  now: number;
};

export type Severity = "critical" | "warning" | "info";
export type Issue = {
  severity: Severity;
  /** problem | scheduling | missing_ref | network */
  category: string;
  /** the object to open: its kind table id, namespace and name */
  kind: string; namespace: string; name: string;
  /** what the object belongs to (an app, a Deployment…) — issues of one app are shown together */
  app: string;
  title: string; detail: string;
  /** how many objects share this issue (pods of one Deployment collapse into one row) */
  count: number;
};
export type Finding = {
  severity: Severity;
  /** security | reliability | efficiency */
  category: string;
  check: string;
  kind: string; namespace: string; name: string;
  title: string; detail: string; fix: string;
};

const SYSTEM_NS = /^(kube-system|kube-public|kube-node-lease|local-path-storage|gatekeeper-system|cattle-.*|calico-.*|tigera-.*)$/;
export const isSystemNs = (ns: string) => SYSTEM_NS.test(ns);

const nsOf = (o: Obj): string => o?.metadata?.namespace ?? "";
const nameOf = (o: Obj): string => o?.metadata?.name ?? "";
const key = (ns: string, name: string) => `${ns}/${name}`;

/** The workload a pod belongs to: Deployment (via its ReplicaSet's name), StatefulSet, DaemonSet, Job/CronJob. */
export function ownerOf(pod: Obj): { kind: string; name: string } | null {
  const ref = (pod?.metadata?.ownerReferences ?? []).find((r: Obj) => r.controller) ?? pod?.metadata?.ownerReferences?.[0];
  if (!ref) return null;
  switch (ref.kind) {
    case "ReplicaSet": {
      // <deployment>-<pod-template-hash>
      const hash = pod.metadata.labels?.["pod-template-hash"];
      const name = hash && ref.name.endsWith(`-${hash}`) ? ref.name.slice(0, -hash.length - 1) : ref.name.replace(/-[a-z0-9]{6,10}$/, "");
      return { kind: "deployments", name };
    }
    case "StatefulSet": return { kind: "statefulsets", name: ref.name };
    case "DaemonSet": return { kind: "daemonsets", name: ref.name };
    case "Job": {
      // a Job of a CronJob: <cronjob>-<schedule time>
      return /-\d{8,}$/.test(ref.name) ? { kind: "cronjobs", name: ref.name.replace(/-\d{8,}$/, "") } : { kind: "jobs", name: ref.name };
    }
    default: return { kind: ref.kind.toLowerCase() + "s", name: ref.name };
  }
}

/** The app an object belongs to: the standard label, the `app` label, or its owner's name. */
export function appOf(o: Obj): string {
  const l = o?.metadata?.labels ?? o?.spec?.template?.metadata?.labels ?? {};
  const tl = o?.spec?.template?.metadata?.labels ?? {};
  return l["app.kubernetes.io/instance"] ?? l["app.kubernetes.io/name"] ?? l.app ?? tl["app.kubernetes.io/name"] ?? tl.app
    ?? (o?.kind === "Pod" || o?.spec?.containers ? ownerOf(o)?.name : undefined) ?? nameOf(o);
}

const podSpec = (o: Obj): Obj => (o?.spec?.containers ? o.spec : o?.spec?.jobTemplate?.spec?.template?.spec ?? o?.spec?.template?.spec ?? {});
const allContainers = (spec: Obj): Obj[] => [...(spec.initContainers ?? []), ...(spec.containers ?? [])];

function selectorMatches(sel: Record<string, string> | undefined, labels: Record<string, string> | undefined): boolean {
  if (!sel || !Object.keys(sel).length) return false;
  const l = labels ?? {};
  return Object.entries(sel).every(([k, v]) => l[k] === v);
}

// ---------- problems ----------

/** Why a container does not run, from its state (waiting / last termination). */
function containerTrouble(cs: Obj): { severity: Severity; title: string; detail: string } | null {
  const w = cs.state?.waiting;
  const last = cs.lastState?.terminated;
  const reason: string = w?.reason ?? "";
  if (reason === "CrashLoopBackOff") {
    const why = last ? `${last.reason ?? "Error"}, код ${last.exitCode}` : "";
    return { severity: "critical", title: `CrashLoopBackOff: ${cs.name}`, detail: `Контейнер падает и перезапускается (рестартов: ${cs.restartCount ?? 0}${why ? `, последний выход: ${why}` : ""}). Смотрите логи предыдущего запуска: kubectl logs --previous.` };
  }
  if (reason === "ImagePullBackOff" || reason === "ErrImagePull" || reason === "InvalidImageName") {
    return { severity: "critical", title: `Образ не скачивается: ${cs.name}`, detail: `${reason}: ${w?.message ?? cs.image ?? ""}. Проверьте имя и тег образа и imagePullSecrets для приватного реестра.` };
  }
  if (reason === "CreateContainerConfigError" || reason === "CreateContainerError") {
    return { severity: "critical", title: `Контейнер не создаётся: ${cs.name}`, detail: `${reason}: ${w?.message ?? ""}` };
  }
  if (last?.reason === "OOMKilled") {
    return { severity: "warning", title: `OOMKilled: ${cs.name}`, detail: `Контейнер убит за превышение лимита памяти (рестартов: ${cs.restartCount ?? 0}). Поднимите resources.limits.memory или найдите утечку.` };
  }
  if ((cs.restartCount ?? 0) >= 5 && !cs.ready) {
    return { severity: "warning", title: `Частые перезапуски: ${cs.name}`, detail: `Рестартов: ${cs.restartCount}, контейнер не готов${last ? ` (последний выход: ${last.reason ?? "Error"}, код ${last.exitCode})` : ""}.` };
  }
  return null;
}

/** References from a pod spec to ConfigMaps, Secrets and PVCs that must exist (optional ones are skipped). */
export function podRefs(spec: Obj): { kind: "configmaps" | "secrets" | "persistentvolumeclaims"; name: string; where: string }[] {
  const out: { kind: "configmaps" | "secrets" | "persistentvolumeclaims"; name: string; where: string }[] = [];
  for (const v of spec.volumes ?? []) {
    if (v.configMap && !v.configMap.optional) out.push({ kind: "configmaps", name: v.configMap.name, where: `volume ${v.name}` });
    if (v.secret && !v.secret.optional) out.push({ kind: "secrets", name: v.secret.secretName, where: `volume ${v.name}` });
    if (v.persistentVolumeClaim) out.push({ kind: "persistentvolumeclaims", name: v.persistentVolumeClaim.claimName, where: `volume ${v.name}` });
    for (const s of v.projected?.sources ?? []) {
      if (s.configMap && !s.configMap.optional) out.push({ kind: "configmaps", name: s.configMap.name, where: `volume ${v.name}` });
      if (s.secret && !s.secret.optional) out.push({ kind: "secrets", name: s.secret.name, where: `volume ${v.name}` });
    }
  }
  for (const c of allContainers(spec)) {
    for (const e of c.envFrom ?? []) {
      if (e.configMapRef && !e.configMapRef.optional) out.push({ kind: "configmaps", name: e.configMapRef.name, where: `${c.name}: envFrom` });
      if (e.secretRef && !e.secretRef.optional) out.push({ kind: "secrets", name: e.secretRef.name, where: `${c.name}: envFrom` });
    }
    for (const e of c.env ?? []) {
      const cm = e.valueFrom?.configMapKeyRef, s = e.valueFrom?.secretKeyRef;
      if (cm && !cm.optional) out.push({ kind: "configmaps", name: cm.name, where: `${c.name}: env ${e.name}` });
      if (s && !s.optional) out.push({ kind: "secrets", name: s.name, where: `${c.name}: env ${e.name}` });
    }
  }
  for (const s of spec.imagePullSecrets ?? []) if (s.name) out.push({ kind: "secrets", name: s.name, where: "imagePullSecrets" });
  return out.filter((r) => r.name);
}

const REF_LABEL = { configmaps: "ConfigMap", secrets: "Secret", persistentvolumeclaims: "PVC" } as const;

export function findProblems(s: Snapshot): Issue[] {
  const out: Issue[] = [];
  const exists = {
    configmaps: new Set(s.configmaps.map((x) => key(x.namespace, x.name))),
    secrets: new Set(s.secrets.map((x) => key(x.namespace, x.name))),
    persistentvolumeclaims: new Set(s.pvcs.map((x) => key(nsOf(x), nameOf(x)))),
  };
  // pods of one workload with the same trouble collapse into one row (the first pod is the one to open)
  const byGroup = new Map<string, Issue>();
  const add = (i: Issue, group?: string) => {
    if (!group) { out.push(i); return; }
    const g = byGroup.get(group);
    if (g) g.count++; else { byGroup.set(group, i); out.push(i); }
  };

  for (const p of s.pods) {
    const ns = nsOf(p), name = nameOf(p), app = appOf(p);
    const owner = ownerOf(p);
    const grp = (t: string) => `${ns}|${owner ? owner.kind + "/" + owner.name : name}|${t}`;
    const base = { kind: "pods", namespace: ns, name, app, count: 1 };

    // stuck Terminating: the finalizers are what holds it
    const del = p.metadata?.deletionTimestamp;
    if (del && s.now - new Date(del).getTime() > 5 * 60_000) {
      const fin = (p.metadata.finalizers ?? []).join(", ");
      add({ ...base, severity: "warning", category: "problem", title: "Завис в Terminating", detail: `Удаляется дольше 5 минут${fin ? `; держат finalizers: ${fin}` : " (узел недоступен или процесс не завершается)"}.` }, grp("terminating"));
      continue;
    }
    if (p.status?.phase === "Failed") {
      const reason = p.status.reason ?? "Failed";
      // evicted pods of a running Deployment are leftovers, not an outage
      add({ ...base, severity: reason === "Evicted" ? "info" : "warning", category: "problem", title: reason === "Evicted" ? "Evicted" : `Под завершился с ошибкой (${reason})`, detail: p.status.message ?? "" }, grp(`failed-${reason}`));
      continue;
    }
    if (p.status?.phase === "Pending") {
      const sched = (p.status.conditions ?? []).find((c: Obj) => c.type === "PodScheduled");
      if (sched?.status === "False") {
        add({ ...base, severity: "critical", category: "scheduling", title: `Не назначается на узел (${sched.reason ?? "Unschedulable"})`, detail: sched.message ?? "" }, grp("unschedulable"));
        continue;
      }
    }
    for (const cs of [...(p.status?.initContainerStatuses ?? []), ...(p.status?.containerStatuses ?? [])]) {
      const t = containerTrouble(cs);
      if (t) add({ ...base, category: "problem", ...t }, grp(t.title));
    }
    for (const r of podRefs(podSpec(p))) {
      if (!exists[r.kind].has(key(ns, r.name))) {
        add({ ...base, severity: "critical", category: "missing_ref", title: `Нет ${REF_LABEL[r.kind]} «${r.name}»`, detail: `На него ссылается ${r.where}, а в namespace ${ns} его нет — под не стартует, пока объект не появится.` }, grp(`ref-${r.kind}-${r.name}`));
      }
    }
  }

  // workloads whose rollout does not finish
  for (const d of s.deployments) {
    const want = d.spec?.replicas ?? 1;
    if (!want) continue;
    const avail = d.status?.availableReplicas ?? 0;
    const prog = (d.status?.conditions ?? []).find((c: Obj) => c.type === "Progressing");
    const base = { kind: "deployments", namespace: nsOf(d), name: nameOf(d), app: appOf(d), count: 1, category: "problem" };
    if (prog?.reason === "ProgressDeadlineExceeded") {
      out.push({ ...base, severity: "critical", title: "Rollout не докатился (ProgressDeadlineExceeded)", detail: `${avail}/${want} доступно. ${prog.message ?? ""}` });
    } else if (avail === 0) {
      out.push({ ...base, severity: "critical", title: `Нет доступных реплик: 0/${want}`, detail: "Приложение не обслуживает запросы — смотрите проблемы его подов ниже." });
    } else if (avail < want && (d.status?.updatedReplicas ?? want) >= want) {
      out.push({ ...base, severity: "warning", title: `Доступно ${avail}/${want}`, detail: "Часть реплик не готова." });
    }
  }
  for (const st of s.statefulsets) {
    const want = st.spec?.replicas ?? 1, ready = st.status?.readyReplicas ?? 0;
    if (want && ready < want) {
      out.push({ kind: "statefulsets", namespace: nsOf(st), name: nameOf(st), app: appOf(st), count: 1, category: "problem", severity: ready === 0 ? "critical" : "warning", title: `Готово ${ready}/${want}`, detail: "StatefulSet поднимает поды по одному: следующий ждёт, пока предыдущий станет Ready." });
    }
  }
  for (const ds of s.daemonsets) {
    const un = ds.status?.numberUnavailable ?? 0, want = ds.status?.desiredNumberScheduled ?? 0;
    if (un > 0) out.push({ kind: "daemonsets", namespace: nsOf(ds), name: nameOf(ds), app: appOf(ds), count: 1, category: "problem", severity: "warning", title: `Недоступен на ${un} из ${want} узлов`, detail: "" });
  }
  for (const j of s.jobs) {
    const failed = (j.status?.conditions ?? []).find((c: Obj) => c.type === "Failed" && c.status === "True");
    if (failed) out.push({ kind: "jobs", namespace: nsOf(j), name: nameOf(j), app: appOf(j), count: 1, category: "problem", severity: "warning", title: `Job упал (${failed.reason ?? "Failed"})`, detail: failed.message ?? "" });
  }
  for (const pvc of s.pvcs) {
    if (pvc.status?.phase === "Pending") out.push({ kind: "persistentvolumeclaims", namespace: nsOf(pvc), name: nameOf(pvc), app: appOf(pvc), count: 1, category: "problem", severity: "warning", title: "PVC не привязан (Pending)", detail: `StorageClass: ${pvc.spec?.storageClassName ?? "по умолчанию"}. Нет подходящего PV или провайдер томов не отвечает.` });
  }

  // services: a selector that matches nothing, or nothing ready behind it
  const readyBySvc = new Map<string, number>();
  for (const es of s.endpointslices) {
    const svc = es.metadata?.labels?.["kubernetes.io/service-name"];
    if (!svc) continue;
    const k = key(nsOf(es), svc);
    const n = (es.endpoints ?? []).filter((e: Obj) => e.conditions?.ready !== false).length;
    readyBySvc.set(k, (readyBySvc.get(k) ?? 0) + n);
  }
  const haveSlices = s.endpointslices.length > 0;
  for (const svc of s.services) {
    const sel = svc.spec?.selector;
    if (!sel || svc.spec?.type === "ExternalName") continue;
    const ns = nsOf(svc), name = nameOf(svc);
    const base = { kind: "services", namespace: ns, name, app: appOf(svc), count: 1, category: "network" };
    const pods = s.pods.filter((p) => nsOf(p) === ns && selectorMatches(sel, p.metadata?.labels));
    if (!pods.length) {
      out.push({ ...base, severity: "critical", title: "Селектор не находит ни одного пода", detail: `selector: ${Object.entries(sel).map(([k, v]) => `${k}=${v}`).join(", ")} — трафик сервиса идёт в никуда. Сверьте с labels подов.` });
      continue;
    }
    if (haveSlices && !readyBySvc.get(key(ns, name))) {
      out.push({ ...base, severity: "critical", title: "Нет готовых endpoints", detail: `Поды под селектор есть (${pods.length}), но ни один не Ready — проверьте readinessProbe и проблемы подов.` });
      continue;
    }
    // a named targetPort that no container declares
    for (const port of svc.spec?.ports ?? []) {
      const tp = port.targetPort;
      if (typeof tp !== "string" || /^\d+$/.test(tp)) continue;
      const declared = pods.some((p) => (p.spec?.containers ?? []).some((c: Obj) => (c.ports ?? []).some((cp: Obj) => cp.name === tp)));
      if (!declared) out.push({ ...base, severity: "warning", title: `targetPort «${tp}» не объявлен в подах`, detail: `Порт сервиса ${port.port} ведёт на именованный порт ${tp}, но ни один контейнер под селектором не объявляет порт с таким именем.` });
    }
  }
  // ingresses to services that do not exist or have no such port
  const svcByKey = new Map(s.services.map((x) => [key(nsOf(x), nameOf(x)), x]));
  for (const ing of s.ingresses) {
    const ns = nsOf(ing);
    const backends: Obj[] = [];
    if (ing.spec?.defaultBackend?.service) backends.push(ing.spec.defaultBackend.service);
    for (const r of ing.spec?.rules ?? []) for (const p of r.http?.paths ?? []) if (p.backend?.service) backends.push({ ...p.backend.service, host: r.host, path: p.path });
    for (const b of backends) {
      const svc = svcByKey.get(key(ns, b.name));
      const where = `${b.host ?? "*"}${b.path ?? ""}`;
      const base = { kind: "ingresses", namespace: ns, name: nameOf(ing), app: appOf(ing), count: 1, category: "network" };
      if (!svc) { out.push({ ...base, severity: "critical", title: `Сервиса «${b.name}» нет`, detail: `Маршрут ${where} ведёт на сервис, которого нет в namespace ${ns}.` }); continue; }
      const want = b.port?.number ?? b.port?.name;
      if (want !== undefined && !(svc.spec?.ports ?? []).some((p: Obj) => p.port === want || p.name === want)) {
        out.push({ ...base, severity: "critical", title: `У сервиса «${b.name}» нет порта ${want}`, detail: `Маршрут ${where}; порты сервиса: ${(svc.spec?.ports ?? []).map((p: Obj) => p.name ? `${p.name}:${p.port}` : p.port).join(", ")}.` });
      }
    }
  }
  return sortIssues(out);
}

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
/** Most severe first; within one severity, issues of one app stay together. */
export function sortIssues<T extends { severity: Severity; app?: string; namespace: string; name: string }>(list: T[]): T[] {
  return list.sort((a, b) => RANK[a.severity] - RANK[b.severity] || (a.app ?? "").localeCompare(b.app ?? "") || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}

// ---------- checks (best practices) ----------

const DANGEROUS_CAPS = new Set(["ALL", "SYS_ADMIN", "NET_ADMIN", "SYS_PTRACE", "SYS_MODULE", "DAC_READ_SEARCH", "NET_RAW"]);
const RUNTIME_SOCKETS = /(docker|containerd|crio|cri-dockerd)\.sock$|^\/var\/run\/docker\.sock$|^\/run\/containerd/;

/** Workloads to check: Deployments, StatefulSets, DaemonSets, CronJobs, and Jobs/pods nobody owns. */
function workloads(s: Snapshot): { kind: string; o: Obj }[] {
  return [
    ...s.deployments.map((o) => ({ kind: "deployments", o })),
    ...s.statefulsets.map((o) => ({ kind: "statefulsets", o })),
    ...s.daemonsets.map((o) => ({ kind: "daemonsets", o })),
    ...s.cronjobs.map((o) => ({ kind: "cronjobs", o })),
    ...s.jobs.filter((j) => !(j.metadata?.ownerReferences ?? []).length).map((o) => ({ kind: "jobs", o })),
    ...s.pods.filter((p) => !(p.metadata?.ownerReferences ?? []).length).map((o) => ({ kind: "pods", o })),
  ];
}

export function runChecks(s: Snapshot): Finding[] {
  const out: Finding[] = [];
  const pdbs = s.pdbs;
  for (const { kind, o } of workloads(s)) {
    const spec = podSpec(o);
    const ns = nsOf(o), name = nameOf(o);
    const f = (severity: Severity, category: string, check: string, title: string, detail: string, fix: string) =>
      out.push({ severity, category, check, kind, namespace: ns, name, title, detail, fix });
    const longRunning = kind !== "cronjobs" && kind !== "jobs";

    // ----- security -----
    if (spec.hostNetwork) f("warning", "security", "host-network", "hostNetwork: true", "Под видит сеть узла целиком и может слушать его порты.", "Уберите hostNetwork, если это не сетевой агент (CNI, ingress на узле).");
    if (spec.hostPID || spec.hostIPC) f("critical", "security", "host-pid-ipc", `${spec.hostPID ? "hostPID" : "hostIPC"}: true`, "Под видит процессы или общую память узла — выход из контейнера становится тривиальным.", "Уберите hostPID/hostIPC.");
    for (const v of spec.volumes ?? []) {
      if (v.hostPath && RUNTIME_SOCKETS.test(v.hostPath.path ?? "")) f("critical", "security", "runtime-socket", `Смонтирован сокет рантайма (${v.hostPath.path})`, "Доступ к docker/containerd-сокету — это root на узле.", "Не монтируйте сокет рантайма; для сборки образов используйте kaniko/buildkit rootless.");
      else if (v.hostPath) f("info", "security", "host-path", `hostPath ${v.hostPath.path}`, "Под читает или пишет файлы узла.", "Замените на PVC, ConfigMap или emptyDir, если узел не нужен.");
    }
    for (const c of allContainers(spec)) {
      const sc = c.securityContext ?? {};
      if (sc.privileged) f("critical", "security", "privileged", `privileged: ${c.name}`, "Привилегированный контейнер имеет все права узла.", "Уберите privileged: true; добавьте только нужные capabilities.");
      if (sc.allowPrivilegeEscalation === true) f("warning", "security", "priv-escalation", `allowPrivilegeEscalation: ${c.name}`, "Процесс может получить больше прав, чем у родителя (setuid).", "Поставьте securityContext.allowPrivilegeEscalation: false.");
      const caps = (sc.capabilities?.add ?? []).filter((x: string) => DANGEROUS_CAPS.has(String(x).toUpperCase()));
      if (caps.length) f("warning", "security", "capabilities", `Опасные capabilities: ${c.name}`, `Добавлены ${caps.join(", ")}.`, "Оставьте только действительно нужные capabilities, начните с drop: [ALL].");
      if (sc.runAsUser === 0 || (sc.runAsNonRoot === false)) f("warning", "security", "run-as-root", `Запуск от root: ${c.name}`, "Контейнер явно запускается от root.", "Задайте runAsNonRoot: true и непривилегированный runAsUser.");
    }

    // ----- reliability -----
    for (const c of spec.containers ?? []) {
      const img: string = c.image ?? "";
      const tag = img.includes("@") ? "digest" : img.slice(img.lastIndexOf("/") + 1).includes(":") ? img.slice(img.lastIndexOf(":") + 1) : "";
      if (!tag || tag === "latest") f("warning", "reliability", "latest-tag", `Образ без версии: ${c.name}`, `${img} — ${tag ? "тег latest" : "тег не указан (= latest)"}: после перезапуска пода может приехать другая версия.`, "Укажите конкретный тег или digest образа.");
      if (longRunning && !c.livenessProbe) f("info", "reliability", "no-liveness", `Нет livenessProbe: ${c.name}`, "Зависший процесс не будет перезапущен.", "Добавьте livenessProbe (httpGet/tcpSocket/exec).");
      if (longRunning && !c.readinessProbe && kind !== "daemonsets") f("warning", "reliability", "no-readiness", `Нет readinessProbe: ${c.name}`, "Трафик пойдёт в под до того, как приложение готово, и во время его остановки.", "Добавьте readinessProbe.");
    }
    if (kind === "deployments" && (o.spec?.replicas ?? 1) === 1) f("info", "reliability", "single-replica", "Одна реплика", "Любой перезапуск или переезд пода — простой.", "Поставьте replicas: 2 и больше для сервисов, где важна доступность.");
    if ((kind === "deployments" || kind === "statefulsets") && (o.spec?.replicas ?? 1) > 1) {
      const labels = o.spec?.template?.metadata?.labels ?? {};
      const covered = pdbs.some((p) => nsOf(p) === ns && selectorMatches(p.spec?.selector?.matchLabels, labels));
      if (!covered) f("info", "reliability", "no-pdb", "Нет PodDisruptionBudget", "При обслуживании узлов (drain) все реплики могут уйти одновременно.", "Добавьте PodDisruptionBudget с minAvailable или maxUnavailable.");
    }

    // ----- efficiency -----
    for (const c of spec.containers ?? []) {
      const r = c.resources ?? {};
      if (!r.requests?.cpu || !r.requests?.memory) f("warning", "efficiency", "no-requests", `Нет requests: ${c.name}`, `Не заданы ${[!r.requests?.cpu && "cpu", !r.requests?.memory && "memory"].filter(Boolean).join(" и ")} — планировщик ставит под вслепую, а при нехватке памяти его выселяют первым.`, "Задайте resources.requests по реальному потреблению (смотрите CPU/RAM в таблице подов).");
      if (!r.limits?.memory) f("info", "efficiency", "no-memory-limit", `Нет лимита памяти: ${c.name}`, "Утечка памяти в контейнере может вытеснить соседей по узлу.", "Задайте resources.limits.memory.");
    }
  }
  return sortIssues(out);
}

/** Text for the AI panel: one issue with its context. */
export function issueForAi(i: Issue | Finding, context: string): string {
  const fix = "fix" in i ? `\nРекомендация: ${i.fix}` : "";
  return `Kubernetes (${context}), ${i.kind} ${i.namespace ? i.namespace + "/" : ""}${i.name}: ${i.title}.\n${i.detail}${fix}\n\nЧто проверить и как исправить?`;
}
