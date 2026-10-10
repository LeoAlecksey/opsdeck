import { describe, expect, it } from "vitest";
import { appOf, findProblems, ownerOf, podRefs, runChecks, type Snapshot } from "../../src/modules/k8s-issues";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const snap = (p: Partial<Snapshot>): Snapshot => ({
  pods: [], deployments: [], statefulsets: [], daemonsets: [], jobs: [], cronjobs: [], services: [], endpointslices: [],
  ingresses: [], pvcs: [], pdbs: [], configmaps: [], secrets: [], now: NOW, ...p,
});
const meta = (name: string, extra: object = {}) => ({ name, namespace: "shop", ...extra });
const rsPod = (name: string, deploy: string, status: object, spec: object = {}) => ({
  kind: "Pod",
  metadata: meta(name, { labels: { app: deploy, "pod-template-hash": "7d9f8c6b5d" }, ownerReferences: [{ kind: "ReplicaSet", name: `${deploy}-7d9f8c6b5d`, controller: true }] }),
  spec: { containers: [{ name: "app", image: "registry.example.com/app:1.2" }], ...spec },
  status: { phase: "Running", ...status },
});
const crash = { containerStatuses: [{ name: "app", ready: false, restartCount: 7, state: { waiting: { reason: "CrashLoopBackOff" } }, lastState: { terminated: { reason: "Error", exitCode: 137 } } }] };

describe("owner and app", () => {
  it("a pod of a ReplicaSet belongs to the Deployment", () => {
    const p = rsPod("api-7d9f8c6b5d-x2kfp", "api", {});
    expect(ownerOf(p)).toEqual({ kind: "deployments", name: "api" });
    expect(appOf(p)).toBe("api");
  });
  it("a Job made by a CronJob points at the CronJob", () => {
    expect(ownerOf({ metadata: { ownerReferences: [{ kind: "Job", name: "backup-29340000", controller: true }] } })).toEqual({ kind: "cronjobs", name: "backup" });
  });
});

describe("problems", () => {
  it("pods of one Deployment with the same crash collapse into one row, most severe first", () => {
    const r = findProblems(snap({ pods: [rsPod("api-7d9f8c6b5d-a", "api", crash), rsPod("api-7d9f8c6b5d-b", "api", crash), rsPod("web-1", "web", {})] }));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ severity: "critical", title: "CrashLoopBackOff: app", count: 2, app: "api", kind: "pods" });
    expect(r[0].detail).toContain("код 137");
  });

  it("image pull, OOMKilled, unschedulable and stuck Terminating", () => {
    const r = findProblems(snap({ pods: [
      rsPod("a-1", "a", { containerStatuses: [{ name: "app", ready: false, state: { waiting: { reason: "ImagePullBackOff", message: "not found" } } }] }),
      rsPod("b-1", "b", { containerStatuses: [{ name: "app", ready: true, restartCount: 2, state: { running: {} }, lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } } }] }),
      rsPod("c-1", "c", { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/3 nodes: insufficient memory" }] }),
      { ...rsPod("d-1", "d", {}), metadata: { ...rsPod("d-1", "d", {}).metadata, deletionTimestamp: "2026-10-11T11:00:00Z", finalizers: ["example.com/cleanup"] } },
    ] }));
    const titles = r.map((x) => x.title);
    expect(titles).toContain("Образ не скачивается: app");
    expect(titles).toContain("OOMKilled: app");
    expect(titles).toContain("Не назначается на узел (Unschedulable)");
    expect(r.find((x) => x.title === "Завис в Terminating")!.detail).toContain("example.com/cleanup");
  });

  it("a reference to a missing Secret is found, an optional or existing one is not", () => {
    const spec = { volumes: [{ name: "tls", secret: { secretName: "tls-cert" } }, { name: "opt", secret: { secretName: "maybe", optional: true } }],
      containers: [{ name: "app", image: "x:1", envFrom: [{ configMapRef: { name: "settings" } }], env: [{ name: "DB", valueFrom: { secretKeyRef: { name: "db", key: "url" } } }] }] };
    expect(podRefs(spec).map((r) => r.name)).toEqual(["tls-cert", "settings", "db"]);
    const r = findProblems(snap({ pods: [rsPod("a-1", "a", {}, spec)], configmaps: [{ namespace: "shop", name: "settings" }], secrets: [{ namespace: "shop", name: "db" }] }));
    expect(r.map((x) => x.title)).toEqual(["Нет Secret «tls-cert»"]);
  });

  it("rollouts: deadline exceeded, zero available", () => {
    const r = findProblems(snap({ deployments: [
      { metadata: meta("api"), spec: { replicas: 3 }, status: { availableReplicas: 1, conditions: [{ type: "Progressing", reason: "ProgressDeadlineExceeded", message: "timed out" }] } },
      { metadata: meta("worker"), spec: { replicas: 2 }, status: {} },
      { metadata: meta("ok"), spec: { replicas: 2 }, status: { availableReplicas: 2 } },
      { metadata: meta("off"), spec: { replicas: 0 }, status: {} },
    ] }));
    expect(r.map((x) => `${x.name}: ${x.title}`)).toEqual(["api: Rollout не докатился (ProgressDeadlineExceeded)", "worker: Нет доступных реплик: 0/2"]);
  });

  it("services: selector matches nothing, no ready endpoints; ingress to a missing service or port", () => {
    const pod = rsPod("api-1", "api", { containerStatuses: [{ name: "app", ready: true, state: { running: {} } }] });
    const r = findProblems(snap({
      pods: [pod],
      services: [
        { metadata: meta("api"), spec: { selector: { app: "api" }, ports: [{ port: 80, targetPort: "http" }] } },
        { metadata: meta("old"), spec: { selector: { app: "gone" }, ports: [{ port: 80 }] } },
      ],
      endpointslices: [{ metadata: meta("api-abc", { labels: { "kubernetes.io/service-name": "api" } }), endpoints: [{ conditions: { ready: true } }] }],
      ingresses: [{ metadata: meta("site"), spec: { rules: [{ host: "shop.example.com", http: { paths: [
        { path: "/", backend: { service: { name: "api", port: { number: 8080 } } } },
        { path: "/old", backend: { service: { name: "nope", port: { number: 80 } } } }] } }] } }],
    }));
    const t = r.map((x) => `${x.kind}/${x.name}: ${x.title}`);
    expect(t).toContain("services/old: Селектор не находит ни одного пода");
    expect(t).toContain("services/api: targetPort «http» не объявлен в подах");
    expect(t).toContain("ingresses/site: Сервиса «nope» нет");
    expect(t).toContain("ingresses/site: У сервиса «api» нет порта 8080");
  });
});

describe("checks", () => {
  const deploy = (containers: object[], extra: object = {}, replicas = 2) => ({
    metadata: meta("api"), spec: { replicas, template: { metadata: { labels: { app: "api" } }, spec: { containers, ...extra } } },
  });
  const good = { name: "app", image: "registry.example.com/api:1.4.2", livenessProbe: {}, readinessProbe: {},
    resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { memory: "256Mi" } }, securityContext: { allowPrivilegeEscalation: false } };

  it("a well-made Deployment with a PDB has no findings", () => {
    const pdb = { metadata: meta("api"), spec: { selector: { matchLabels: { app: "api" } } } };
    expect(runChecks(snap({ deployments: [deploy([good])], pdbs: [pdb] }))).toEqual([]);
  });

  it("security, reliability and efficiency findings, with a fix each", () => {
    const bad = { name: "app", image: "nginx", securityContext: { privileged: true, capabilities: { add: ["SYS_ADMIN"] } } };
    const r = runChecks(snap({ deployments: [deploy([bad], { hostPID: true, volumes: [{ name: "d", hostPath: { path: "/var/run/docker.sock" } }] }, 1)] }));
    const checks = r.map((x) => x.check);
    for (const c of ["privileged", "capabilities", "host-pid-ipc", "runtime-socket", "latest-tag", "no-readiness", "no-liveness", "single-replica", "no-requests", "no-memory-limit"]) {
      expect(checks, c).toContain(c);
    }
    expect(r[0].severity).toBe("critical");
    expect(r.every((x) => x.fix.length > 0)).toBe(true);
  });

  it("CronJobs are checked by their pod template, without probe checks", () => {
    const cj = { metadata: meta("backup"), spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: "b", image: "backup:latest" }] } } } } } };
    const checks = runChecks(snap({ cronjobs: [cj] })).map((x) => x.check);
    expect(checks).toContain("latest-tag");
    expect(checks).not.toContain("no-readiness");
  });
});
