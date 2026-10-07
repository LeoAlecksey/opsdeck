// Fake Tauri backend for UI tests and website screenshots. Demo data only: example.com and the
// documentation IP ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24).
//   window.__calls            — every invoke: { cmd, args }
//   window.__demoEmit(e, p)   — fire a backend event
//   window.__DEMO_OVERRIDES   — { command: value | (args) => value } replaces an answer
//   window.__DEMO_LANG        — "ru" (default) or "en": UI language and demo texts
(() => {
  const LANG = window.__DEMO_LANG || "ru";
  try { localStorage.setItem("opsdeck.lang", LANG); } catch {}
  const L = (ru, en) => (LANG === "ru" ? ru : en);
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const M = 60e3, H = 3600e3, D = 86400e3, GiB = 1073741824;
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
  const b64 = (s) => btoa(unescape(encodeURIComponent(s)));

  // ---- event bus (tauri `listen`) ----
  let cbid = 0;
  const handlers = {}; // event -> [callback id]
  const emit = (event, payload) => (handlers[event] || []).forEach((id) => { try { window[`_${id}`]?.({ event, payload, id }); } catch (e) { console.error(e); } });
  window.__demoEmit = emit;
  window.__calls = [];

  // ---- Kubernetes ----
  const ctx = { file: "/home/demo/.config/opsdeck/kube/prod-eu.yaml", source: "opsdeck", label: "prod-eu", context: "prod-eu", cluster: "prod-eu", user: "admin", namespace: "shop", current: true, server: "https://k8s.example.com:6443" };
  const ctx2 = { ...ctx, file: "/home/demo/.config/opsdeck/kube/stage.yaml", label: "stage", context: "stage", cluster: "stage", current: false, server: "https://stage.k8s.example.com:6443" };
  let uid = 0;
  const pod = (name, nsx, node, status = "Running", restarts = 0, ageMs = 3 * D, ready = true, img = "registry.example.com/shop/api:1.42.0") => ({
    metadata: { name, namespace: nsx, uid: `u${++uid}`, creationTimestamp: iso(ageMs), labels: { app: name.split("-").slice(0, -2).join("-") } },
    spec: { nodeName: node, containers: [{ name: "app", image: img }] },
    status: {
      phase: status === "CrashLoopBackOff" ? "Running" : status, podIP: `10.244.${(uid % 3) + 1}.${20 + uid}`,
      containerStatuses: [{ name: "app", ready, restartCount: restarts, state: status === "CrashLoopBackOff" ? { waiting: { reason: "CrashLoopBackOff" } } : { running: {} } }],
    },
  });
  const pods = [
    pod("api-7d9f8c6b5d-x2kfp", "shop", "node-1", "Running", 0, 2 * D),
    pod("api-7d9f8c6b5d-q8wzn", "shop", "node-2", "Running", 0, 2 * D),
    pod("api-7d9f8c6b5d-m4hrt", "shop", "node-3", "Running", 1, 2 * D),
    pod("worker-5c8d7f9b6-lp2vx", "shop", "node-2", "CrashLoopBackOff", 7, 40 * M, false, "registry.example.com/shop/worker:2.3.1"),
    pod("worker-5c8d7f9b6-t9qjd", "shop", "node-1", "Running", 0, 40 * M, true, "registry.example.com/shop/worker:2.3.1"),
    pod("frontend-6b7c9d8f4-9zk2w", "shop", "node-3", "Running", 0, 5 * D, true, "registry.example.com/shop/web:3.8.2"),
    pod("frontend-6b7c9d8f4-rv7mc", "shop", "node-1", "Running", 0, 5 * D, true, "registry.example.com/shop/web:3.8.2"),
    pod("redis-0", "shop", "node-2", "Running", 0, 21 * D, true, "redis:7.4"),
    pod("postgres-0", "shop", "node-3", "Running", 0, 21 * D, true, "postgres:17"),
    pod("cron-report-29338140-8kx7d", "shop", "node-1", "Succeeded", 0, 3 * H, false, "registry.example.com/shop/report:1.0.4"),
  ];
  const usage = pods.filter((p) => p.status.phase === "Running").map((p, i) => ({ namespace: "shop", name: p.metadata.name, cpu_m: [42, 38, 51, 3, 120, 12, 9, 7, 64][i % 9], mem: [180, 176, 190, 40, 260, 95, 92, 30, 410][i % 9] * 1048576 }));

  // ---- SSH, KeePass, alerts ----
  const sshHosts = [
    { id: "h1", name: "bastion", group: "prod", host: "bastion.example.com", port: 22, user: "ops", identity_file: "~/.ssh/id_ed25519", jump: "", auth: "key", keepass_entry: "" },
    { id: "h2", name: "db-primary", group: "prod", host: "198.51.100.21", port: 22, user: "postgres", identity_file: "", jump: "bastion", auth: "keepass", keepass_entry: "k3" },
    { id: "h3", name: "app-1", group: "prod", host: "198.51.100.11", port: 22, user: "deploy", identity_file: "~/.ssh/id_ed25519", jump: "bastion", auth: "key", keepass_entry: "" },
    { id: "h4", name: "app-2", group: "prod", host: "198.51.100.12", port: 22, user: "deploy", identity_file: "~/.ssh/id_ed25519", jump: "bastion", auth: "key", keepass_entry: "" },
    { id: "h5", name: "stage-1", group: "stage", host: "203.0.113.31", port: 2222, user: "deploy", identity_file: "", jump: "", auth: "key", keepass_entry: "" },
    { id: "h6", name: "build-runner", group: "", host: "192.0.2.40", port: 22, user: "ci", identity_file: "", jump: "", auth: "password", keepass_entry: "" },
  ];
  const sshConfig = [
    { alias: "gitlab", group: "", hostname: "gitlab.example.com", user: "git", port: "22", identity_file: "~/.ssh/id_ed25519", proxy_jump: "", effective: { user: "git", hostname: "gitlab.example.com", port: "22", identity_files: ["~/.ssh/id_ed25519"], proxy_jump: "" } },
    { alias: "monitoring", group: "", hostname: "192.0.2.15", user: "ops", port: "22", identity_file: "", proxy_jump: "", effective: { user: "ops", hostname: "192.0.2.15", port: "22", identity_files: ["~/.ssh/id_ed25519"], proxy_jump: "" } },
  ];
  const kpEntries = [
    { id: "k1", title: "Grafana admin", username: "admin", url: "https://grafana.example.com", group: "Monitoring", tags: ["prod"], has_password: true, has_notes: false },
    { id: "k2", title: "ArgoCD", username: "admin", url: "https://argocd.example.com", group: "Kubernetes", tags: ["prod"], has_password: true, has_notes: true },
    { id: "k3", title: "db-primary postgres", username: "postgres", url: "", group: "Databases", tags: ["prod", "db"], has_password: true, has_notes: true },
    { id: "k4", title: "GitLab", username: "ops", url: "https://gitlab.example.com", group: "Dev", tags: [], has_password: true, has_notes: false },
    { id: "k5", title: "MikroTik core", username: "admin", url: "192.0.2.1", group: "Network", tags: ["office"], has_password: true, has_notes: false },
    { id: "k6", title: "Registry robot", username: "robot$ci", url: "https://registry.example.com", group: "Dev", tags: ["ci"], has_password: true, has_notes: true },
    { id: "k7", title: "S3 backups", username: "backup", url: "https://s3.example.com", group: "Storage", tags: ["backup"], has_password: true, has_notes: false },
  ];
  const alert = (o) => ({ kind: "alert", links: [], fingerprint: o.name + o.inst, status: "firing", silenced: false, source: "Grafana", severity: "warning", summary: "", description: "",
    labels: {}, annotations: {}, starts_at: iso(o.ago), ends_at: "", generator_url: "https://grafana.example.com/alerting", silence_url: "", dashboard_url: "https://grafana.example.com/d/abc", panel_url: "", value: "", received_at: iso(o.ago), acked: false, ...o });
  const alerts = [
    alert({ name: "PodCrashLooping", severity: "critical", summary: L("worker-5c8d7f9b6-lp2vx перезапускается 7 раз за 40 минут", "worker-5c8d7f9b6-lp2vx restarted 7 times in 40 minutes"), labels: { namespace: "shop", pod: "worker-5c8d7f9b6-lp2vx", cluster: "prod-eu" }, ago: 12 * M, inst: "1", value: "7" }),
    alert({ name: "High5xxRate", severity: "warning", summary: L("Доля 5xx на ingress shop-api выросла до 4.2%", "5xx rate on the shop-api ingress is up to 4.2%"), labels: { namespace: "shop", ingress: "shop-api" }, ago: 25 * M, inst: "2", value: "4.2%" }),
    alert({ name: "DiskWillFillIn24h", severity: "warning", source: "Alertmanager", summary: L("Диск /var/lib/postgresql на db-primary заполнится за ~20 ч", "/var/lib/postgresql on db-primary will fill up in ~20 h"), labels: { instance: "db-primary:9100" }, ago: 2 * H, inst: "3" }),
    alert({ name: "CertificateExpiresSoon", severity: "info", summary: L("Сертификат shop.example.com истекает через 14 дней", "Certificate for shop.example.com expires in 14 days"), labels: { host: "shop.example.com" }, ago: 6 * H, inst: "4" }),
    alert({ kind: "ai", name: L("Всплеск ошибок авторизации", "Burst of auth failures"), severity: "warning", source: "log-analyzer", summary: L("В логах api за 10 минут 312 ответов 401 с одного IP 203.0.113.77", "312 responses with 401 from a single IP 203.0.113.77 in api logs over 10 minutes"), labels: { namespace: "shop", app: "api" }, ago: 50 * M, inst: "5" }),
  ];
  const resolved = alerts.slice(0, 2).map((a) => ({ ...a, status: "resolved", fingerprint: a.fingerprint + "r", starts_at: iso(D + 3 * H), ends_at: iso(D + H), received_at: iso(D + 3 * H) }));

  // ---- notes and tasks ----
  const N = LANG === "ru"
    ? { start: "Начало.md", tasks: "Задачи.md", restart: "runbooks/Перезапуск воркера.md", backups: "runbooks/Бэкапы postgres.md", certs: "runbooks/Ротация сертификатов.md", kubectl: "k8s/Полезные команды kubectl.md", helm: "k8s/Helm релизы.md" }
    : { start: "Start.md", tasks: "Tasks.md", restart: "runbooks/Restart the worker.md", backups: "runbooks/Postgres backups.md", certs: "runbooks/Certificate rotation.md", kubectl: "k8s/Handy kubectl commands.md", helm: "k8s/Helm releases.md" };
  window.__DEMO_NOTE = N.restart;
  const vault = { root: "/home/demo/notes", name: "notes", folders: ["runbooks", "k8s", "daily"], notes: [
    { path: N.start, mtime: now - 20 * D }, { path: N.tasks, mtime: now - H },
    { path: N.restart, mtime: now - 2 * D }, { path: N.backups, mtime: now - 6 * D }, { path: N.certs, mtime: now - 12 * D },
    { path: N.kubectl, mtime: now - 3 * D }, { path: N.helm, mtime: now - 9 * D },
    { path: "daily/" + day(0) + ".md", mtime: now - 30 * M } ] };
  const noteText = {
    [N.restart]: L(
      `---\ntags: [runbook, shop]\n---\n# Перезапуск воркера shop\n\nКогда очередь растёт, а воркер в CrashLoopBackOff.\n\n## Проверить\n\n\`\`\`bash\nkubectl -n shop get pods -l app=worker\nkubectl -n shop logs deploy/worker --tail=100\n\`\`\`\n\n## Перезапустить и дождаться выката\n\n\`\`\`bash\nkubectl -n shop rollout restart deploy/worker\nkubectl -n shop rollout status deploy/worker --timeout=120s\n\`\`\`\n\n## Задачи\n\n- [ ] Поднять лимит памяти воркера до 512Mi 📅 ${day(1)} ⏫ #shop\n- [x] Добавить алерт на длину очереди ✅ ${day(-2)}\n\nСм. также [[Полезные команды kubectl]].\n`,
      `---\ntags: [runbook, shop]\n---\n# Restarting the shop worker\n\nWhen the queue grows and the worker is in CrashLoopBackOff.\n\n## Check\n\n\`\`\`bash\nkubectl -n shop get pods -l app=worker\nkubectl -n shop logs deploy/worker --tail=100\n\`\`\`\n\n## Restart and wait for the rollout\n\n\`\`\`bash\nkubectl -n shop rollout restart deploy/worker\nkubectl -n shop rollout status deploy/worker --timeout=120s\n\`\`\`\n\n## Tasks\n\n- [ ] Raise the worker memory limit to 512Mi 📅 ${day(1)} ⏫ #shop\n- [x] Add an alert on queue length ✅ ${day(-2)}\n\nSee also [[Handy kubectl commands]].\n`),
  };
  const tags = [{ tag: "runbook", notes: [N.restart, N.backups] }, { tag: "shop", notes: [N.restart] }, { tag: "k8s", notes: [N.kubectl] }, { tag: "backup", notes: [N.backups] }];
  const task = (text, due, time, priority, tagsx, done = false, path = N.tasks, line = 3) => ({ path, line, raw: "", text, done, due, time, priority, tags: tagsx, done_date: done ? day(-1) : null });
  const tasks = [
    task(L("Обновить сертификат shop.example.com", "Renew the shop.example.com certificate"), day(0), "15:00", 3, ["prod"]),
    task(L("Проверить бэкап postgres после миграции", "Check the postgres backup after the migration"), day(0), "18:30", 2, ["db"], false, N.tasks, 4),
    task(L("Поднять лимит памяти воркера до 512Mi", "Raise the worker memory limit to 512Mi"), day(1), null, 2, ["shop"], false, N.restart, 22),
    task(L("Ревью PR с Helm-чартом мониторинга", "Review the monitoring Helm chart PR"), day(2), "11:00", 1, ["review"], false, N.tasks, 5),
    task(L("Почистить старые образы в registry", "Clean up old images in the registry"), day(4), null, 0, ["ci"], false, N.tasks, 6),
    task(L("Созвон по миграции на новый кластер", "Call about migrating to the new cluster"), day(6), "12:00", 0, [], false, N.tasks, 7),
    task(L("Обновить ранбук по ротации сертификатов", "Update the certificate rotation runbook"), day(-1), null, 1, ["runbook"], false, N.tasks, 8),
    task(L("Добавить алерт на длину очереди", "Add an alert on queue length"), day(-2), null, 0, ["shop"], true, N.restart, 23),
  ];

  // ---- databases ----
  const dbProfiles = [
    { id: "d1", name: "shop prod", group: "prod", engine: "postgres", host: "db.example.com", port: 5432, database: "shop", username: "readonly", auth: "keepass", keepass_entry: "k3", tls: "require", readonly: true, options: "" },
    { id: "d2", name: "analytics", group: "prod", engine: "clickhouse", host: "ch.example.com", port: 8123, database: "default", username: "default", auth: "password", keepass_entry: "", tls: "", readonly: true, options: "" },
    { id: "d3", name: "cache", group: "stage", engine: "redis", host: "192.0.2.50", port: 6379, database: "0", username: "", auth: "none", keepass_entry: "", tls: "", readonly: false, options: "" },
  ];
  const dbTree = (path) => !path || !path.length
    ? [{ name: "public", kind: "schema", detail: L("6 таблиц", "6 tables"), leaf: false, query: null }, { name: "billing", kind: "schema", detail: L("3 таблицы", "3 tables"), leaf: false, query: null }]
    : [["orders", "1.2M"], ["order_items", "3.4M"], ["customers", "210K"], ["products", "4 812"], ["payments", "1.1M"], ["coupons", "96"]]
        .map(([n, d]) => ({ name: n, kind: "table", detail: `${d} ${L("строк", "rows")}`, leaf: true, query: `SELECT * FROM public.${n} LIMIT 100;` }));
  const dbResult = { columns: ["id", "customer", "status", "total", "created_at"], affected: null, truncated: false, elapsed_ms: 23, message: "", docs: null,
    rows: [[48213, "anna@example.com", "paid", "129.90", "2026-10-05 14:02"], [48212, "ivan@example.com", "shipped", "54.00", "2026-10-05 13:47"], [48211, "olga@example.com", "paid", "310.50", "2026-10-05 13:31"],
      [48210, "max@example.com", "refunded", "18.20", "2026-10-05 13:05"], [48209, "kate@example.com", "paid", "77.00", "2026-10-05 12:58"], [48208, "petr@example.com", "new", "245.10", "2026-10-05 12:40"],
      [48207, "sergey@example.com", "shipped", "99.99", "2026-10-05 12:12"], [48206, "lena@example.com", "paid", "64.30", "2026-10-05 11:54"]].map((r) => r.map(String)) };

  // ---- IDE ----
  const proj = "/home/demo/projects/infra";
  const files = {
    [proj]: [["modules", 1], ["envs", 1], ["helm", 1], [".gitlab-ci.yml", 0], ["main.tf", 0], ["variables.tf", 0], ["outputs.tf", 0], ["versions.tf", 0], ["README.md", 0], ["Dockerfile", 0]],
    [proj + "/helm"]: [["shop", 1], ["values-prod.yaml", 0], ["values-stage.yaml", 0]],
    [proj + "/modules"]: [["k8s-cluster", 1], ["network", 1]],
    [proj + "/envs"]: [["prod", 1], ["stage", 1]],
  };
  const mainTf = `terraform {\n  required_version = ">= 1.7"\n  backend "s3" {\n    bucket = "tf-state-example"\n    key    = "infra/prod.tfstate"\n    region = "eu-central-1"\n  }\n}\n\nmodule "network" {\n  source     = "./modules/network"\n  cidr_block = var.vpc_cidr\n  zones      = ["a", "b", "c"]\n}\n\nmodule "cluster" {\n  source       = "./modules/k8s-cluster"\n  name         = "prod-eu"\n  version      = "1.31"\n  node_count   = 3\n  node_type    = "c6i.xlarge"\n  subnet_ids   = module.network.private_subnets\n\n  labels = {\n    team = "platform"\n    env  = "prod"\n  }\n}\n\noutput "kubeconfig" {\n  value     = module.cluster.kubeconfig\n  sensitive = true\n}\n`;
  const commit = (h, parents, refs, subject, ago, author = "Alex") => ({ hash: h, parents, refs, author, time: Math.floor((now - ago) / 1000), subject });
  const commits = [
    commit("a1f3c9e", ["b2e4d10"], ["HEAD -> feature/monitoring"], L("helm: values для prometheus-stack", "helm: values for prometheus-stack"), 20 * M),
    commit("b2e4d10", ["c3d5e21", "f6a8b54"], [], "Merge branch 'main' into feature/monitoring", 2 * H),
    commit("f6a8b54", ["d4c6f32"], ["origin/main", "main"], "cluster: node_count 3 → 4", 3 * H, "Maria"),
    commit("c3d5e21", ["e5b7a43"], [], L("monitoring: alert rules для shop", "monitoring: alert rules for shop"), 5 * H),
    commit("d4c6f32", ["e5b7a43"], ["tag: v2.4.0"], L("network: NAT в каждой зоне", "network: NAT in every zone"), D, "Maria"),
    commit("e5b7a43", ["0a9b8c7"], [], L("ci: terraform fmt -check в пайплайне", "ci: terraform fmt -check in the pipeline"), 2 * D),
    commit("0a9b8c7", ["1b2c3d4"], [], L("cluster: обновление до 1.31", "cluster: upgrade to 1.31"), 3 * D, "Ivan"),
    commit("1b2c3d4", [], [], L("Начальная структура инфраструктуры", "Initial infrastructure layout"), 9 * D),
  ];
  const branches = { current: "feature/monitoring", local: [
    { name: "feature/monitoring", upstream: "origin/feature/monitoring", track: "ahead 2", time: Math.floor((now - 20 * M) / 1000), subject: "helm: values" },
    { name: "main", upstream: "origin/main", track: "", time: Math.floor((now - 3 * H) / 1000), subject: "cluster: node_count 3 → 4" } ],
    remote: [{ name: "origin/main", upstream: "", track: "", time: Math.floor((now - 3 * H) / 1000), subject: "cluster: node_count 3 → 4" }] };

  // ---- terminal ----
  const termOut = [
    "\x1b[1;32mdemo@workstation\x1b[0m:\x1b[1;34m~/projects/infra\x1b[0m$ kubectl -n shop get pods\r\n",
    "NAME                        READY   STATUS             RESTARTS   AGE\r\n",
    "api-7d9f8c6b5d-x2kfp        1/1     \x1b[32mRunning\x1b[0m            0          2d\r\n",
    "api-7d9f8c6b5d-q8wzn        1/1     \x1b[32mRunning\x1b[0m            0          2d\r\n",
    "worker-5c8d7f9b6-lp2vx      0/1     \x1b[31mCrashLoopBackOff\x1b[0m   7          40m\r\n",
    "worker-5c8d7f9b6-t9qjd      1/1     \x1b[32mRunning\x1b[0m            0          40m\r\n",
    "frontend-6b7c9d8f4-9zk2w    1/1     \x1b[32mRunning\x1b[0m            0          5d\r\n",
    "\r\n\x1b[1;32mdemo@workstation\x1b[0m:\x1b[1;34m~/projects/infra\x1b[0m$ kubectl -n shop logs worker-5c8d7f9b6-lp2vx --tail=4\r\n",
    "2026-10-06T09:41:02Z \x1b[36mINFO\x1b[0m  connecting to redis://redis:6379\r\n",
    "2026-10-06T09:41:03Z \x1b[36mINFO\x1b[0m  consumer group shop-orders joined\r\n",
    "2026-10-06T09:41:07Z \x1b[31mERROR\x1b[0m out of memory: heap limit 256Mi exceeded\r\n",
    "2026-10-06T09:41:07Z \x1b[31mERROR\x1b[0m worker exited with code 137\r\n",
    "\r\n\x1b[1;32mdemo@workstation\x1b[0m:\x1b[1;34m~/projects/infra\x1b[0m$ terraform plan -target=module.cluster\r\n",
    "\x1b[1mmodule.cluster.aws_eks_node_group.main\x1b[0m will be updated in-place\r\n",
    "  \x1b[33m~\x1b[0m scaling_config { desired_size = 3 \x1b[33m->\x1b[0m 4 }\r\n",
    "\x1b[1mPlan:\x1b[0m 0 to add, 1 to change, 0 to destroy.\r\n",
    "\r\n\x1b[1;32mdemo@workstation\x1b[0m:\x1b[1;34m~/projects/infra\x1b[0m$ ",
  ].join("");

  const settings = { keepass_path: "/home/demo/Passwords.kdbx", keepass_keyfile: "", keepass_lock_minutes: 0, keepass_keep_open: true, obsidian_vault: "/home/demo/notes", winbox_path: "", k8s_include_system: false, update_auto_check: true, ai_host: "", ai_port: "", ai_model: "", ai_key_saved: false, term_shell: "" };

  const R = {
    win_shells: [], wt_settings: JSON.stringify({ profiles: {}, schemes: [{ name: "Demo WT", background: "#101820", foreground: "#e0e0e0", purple: "#aa66ff", cursorColor: "#ffcc00" }] }),
    app_version: "0.5.0", set_lang: null, log_ui: null, settings_get: settings, settings_detect: { keepass: [], obsidian: [], winbox: [] }, logs_path: "/home/demo/.local/share/opsdeck/logs",
    k8s_contexts: [ctx, ctx2], k8s_system_contexts: [], k8s_prefs_get: { hidden: [], readonly: [`${ctx.file}|prod-eu`] }, k8s_crds: [], k8s_metrics: usage, k8s_helm_releases: [], k8s_object_events: [],
    ssh_list: { hosts: sshHosts, config: sshConfig }, ssh_keys: ["~/.ssh/id_ed25519"], ssh_local_user: "demo",
    ssh_connect: { program: "ssh", args: ["-J", "bastion", "deploy@198.51.100.11"], password_copied: false },
    kp_status: { unlocked: true, path: "/home/demo/Passwords.kdbx", keyfile: "", entries: kpEntries.length, lock_minutes: 0, keep_open: true }, kp_entries: kpEntries,
    alerts_get: { current: alerts, history: [...alerts, ...resolved], firing: alerts.length }, alerts_sources: ["Grafana", "Alertmanager", "log-analyzer"],
    alerts_config_get: { ingest_enabled: true, ingest_port: 9977, poll_enabled: true, poll_seconds: 60, notify: true, notify_resolved: false, muted: [] },
    vaults_list: { active: "/home/demo/notes", vaults: [{ name: "notes", path: "/home/demo/notes", exists: true, obsidian: true, found: true }, { name: "work", path: "/home/demo/work-notes", exists: true, obsidian: false, found: true }] },
    notes_list: vault, notes_tags: tags, tasks_list: tasks, note_search: [],
    db_list: dbProfiles, db_query: dbResult, mt_list: [{ id: "m1", name: "core-router", host: "192.0.2.1", group: "office", username: "admin", auth: "keepass", keepass_entry: "k5", winbox_port: 8291, ssh_port: 22 }],
    snippets_list: [{ id: "s1", title: L("Логи деплоймента", "Deployment logs"), command: "kubectl -n {{ns:shop}} logs deploy/{{name}} --tail=200 -f", tags: ["k8s"] }],
    connectors_list: [
      { id: "c1", kind: "grafana", name: "Grafana", group: "prod", url: "https://grafana.example.com", username: "admin", auth: "keepass", keepass_entry: "k1" },
      { id: "c2", kind: "argocd", name: "Argo CD", group: "prod", url: "https://argocd.example.com", username: "admin", auth: "keepass", keepass_entry: "k2" },
      { id: "c3", kind: "gitlab", name: "GitLab", group: "", url: "https://gitlab.example.com", username: "ops", auth: "keepass", keepass_entry: "k4" }],
    sys_local: { host: "workstation", remote: false, cpu: 14, cores: 16, load: [1.2, 1.4, 1.1], mem_used: 11.4 * GiB, mem_total: 32 * GiB, swap_used: 0, swap_total: 8 * GiB, disk_mount: "/", disk_used: 312 * GiB, disk_total: 954 * GiB, uptime: 4 * 86400 },
    ide_status: { clients: 1 }, editors_detect: [], shell_commands: ["kubectl", "helm", "terraform", "git", "ssh", "docker", "ls", "cd", "cat", "grep"], cmd_suggest: [],
    code_git_log: commits, code_git_branches: branches, fs_git_status: { root: proj, branch: "feature/monitoring", files: { "main.tf": "M", "helm/values-prod.yaml": "M", "outputs.tf": "A" } },
    update_check: { available: false, version: "0.5.0", notes: "", date: "" }, releases_list: [],
    ai_status: { engine: true, model: true, running: true, installing: false, size: 5.9e9, download_size: 0, dir: "/home/demo/.local/share/opsdeck/ai", supported: true, model_title: "Мощная — Qwen3.5 9B" },
    ai_models: { selected: "qwen3.5-9b", custom_path: "", ram_total: 32 * GiB, gpu: true, gpu_supported: true, vulkan_found: true, metal: false, gpu_failed: false, models: [
      { id: "qwen2.5-coder-1.5b", title: "Лёгкая — Qwen2.5-Coder 1.5B", size: 1117320768, ram_gb: 4, installed: true },
      { id: "qwen3.5-4b", title: "Средняя — Qwen3.5 4B", size: 2740937888, ram_gb: 8, installed: false },
      { id: "qwen3.5-9b", title: "Мощная — Qwen3.5 9B", size: 5680522464, ram_gb: 16, installed: true },
      { id: "qwen3.6-35b-a3b", title: "Большая — Qwen3.6 35B-A3B (MoE)", size: 22134528992, ram_gb: 32, installed: false } ] },
    ai_command: { command: "kubectl -n shop rollout restart deploy/worker && kubectl -n shop rollout status deploy/worker --timeout=120s", from_notes: ["kubectl -n shop rollout restart deploy/worker", "kubectl -n shop rollout status deploy/worker --timeout=120s"], elapsed_ms: 1840 },
    ports_listening: [], alerts_poll_now: [], kp_copy: null,
  };

  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    transformCallback: (cb) => { const id = ++cbid; window[`_${id}`] = cb; return id; },
    unregisterCallback: () => {},
    convertFileSrc: (p) => p,
    invoke: async (cmd, args = {}) => {
      if (cmd === "plugin:event|listen") { (handlers[args.event] ||= []).push(args.handler); return args.handler; }
      if (cmd.startsWith("plugin:")) return null;
      window.__calls.push({ cmd, args });
      const ov = window.__DEMO_OVERRIDES?.[cmd];
      if (ov !== undefined) return typeof ov === "function" ? ov(args) : ov;
      if (cmd === "pty_spawn") {
        const id = args.req.id, prog = args.req.program;
        setTimeout(() => emit(`pty-data-${id}`, b64(prog ? L("AI-панель: выберите инструмент сверху\r\n", "AI panel: pick a tool at the top\r\n") : termOut)), 100);
        return { program: prog ?? "/bin/bash", args: args.req.args ?? [] };
      }
      if (cmd === "mon_probe") {
        if (args.target === "id:h6") throw L("нет входа по ключу — добавьте ключ (ssh-copy-id) или откройте сессию в OpsDeck", "no key login — add a key (ssh-copy-id) or open a session in OpsDeck");
        const n = Number(args.target.replace(/\D/g, "")) || 1;
        const disk = args.target === "id:h2" ? 0.95 : 0.4;
        return { host: args.target.replace(/^\w+:/, "") === "h1" ? "bastion" : args.target.split(":")[1], cpu: 10 * n, cores: 4, load: [0.2 * n, 0.3, 0.25], mem_used: 3e9, mem_total: 8e9, swap_used: 0, swap_total: 0, disk_mount: "/", disk_used: disk * 100e9, disk_total: 100e9, uptime: 90000 * n };
      }
      if (cmd === "k8s_list") return args.kind === "namespaces" ? ["default", "kube-system", "monitoring", "shop"].map((n) => ({ metadata: { name: n, uid: n } })) : pods;
      if (cmd === "k8s_watch_start") { setTimeout(() => emit(`k8s-watch-${args.id}`, { type: "reset", items: args.kind === "pods" ? pods : [] }), 50); return null; }
      if (cmd === "db_tree") return dbTree(args.path);
      if (cmd === "note_read") return noteText[args.path] ?? `# ${args.path.split("/").pop().replace(/\.md$/, "")}\n\n${L("Заметка.", "A note.")}\n`;
      if (cmd === "fs_list") { const l = files[args.path]; if (!l) throw "not a dir"; return l.map(([n, d]) => ({ name: n, dir: !!d, link: false, size: d ? 0 : 1200 })); }
      if (cmd === "code_read") return { text: args.path.endsWith("main.tf") ? mainTf : "# demo\n", mtime: now };
      if (cmd === "code_tf_fmt") return { text: null, errors: [], tool: "terraform" };
      if (cmd === "code_git_diff" || cmd === "code_git_show") return "";
      if (cmd in R) return R[cmd];
      return null;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
})();
