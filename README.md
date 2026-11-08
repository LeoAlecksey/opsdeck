# OpsDeck

[![build](https://github.com/LeoAlecksey/opsdeck/actions/workflows/build.yml/badge.svg)](https://github.com/LeoAlecksey/opsdeck/actions/workflows/build.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Telegram](https://img.shields.io/badge/Telegram-sys__admin__expert-26A5E4?logo=telegram&logoColor=white)](https://t.me/sys_admin_expert)
[![Сказать спасибо](https://img.shields.io/badge/Сказать_спасибо-YooMoney-8B5CF6?logo=yoomoney&logoColor=white)](https://yoomoney.ru/to/4100119645604976)

**English** · [Русский](#ru)

<a id="en"></a>

**A DevOps engineer's workspace in one window**: a terminal with an AI panel and a local model, an AI agent that investigates hosts under your rules, Kubernetes, databases, an IDE with git, Grafana/ArgoCD/GitLab in tabs, alerts, notes with tasks and reminders, KeePass and Passbolt, SSH, host monitoring, files between hosts, Yandex Cloud and MikroTik — in one native app for Linux, Windows and macOS.

🌐 **Website with an overview and a guide:** https://leoalecksey.github.io/opsdeck/en/ ([Русский](https://leoalecksey.github.io/opsdeck/))

Stack: **Rust + [Tauri 2](https://tauri.app)** (backend), TypeScript + Vite (UI), [xterm.js](https://xtermjs.org) (terminal), [kube-rs](https://kube.rs) (Kubernetes), [llama.cpp](https://github.com/ggml-org/llama.cpp) (local AI).

---

## Features

### Warp-style terminal + AI next to it
- Tabs and splits, a real shell (bash/zsh/PowerShell, WSL and Git Bash on Windows), colour schemes.
- **Command blocks**: every command gets an exit code and duration, an action bar (copy command/output, save as a snippet, send to AI), an "ask AI" bar on failure, jumping between commands.
- **AI panel** on the right: Claude Code, Codex, Gemini, Aider or OpenCode in their own terminal (up to three side by side); a selection or a command's output goes there with one key.
- **Claude Code IDE integration**: `claude` started inside OpsDeck connects to it by itself (MCP over WebSocket on 127.0.0.1) — it sees the selection in notes and gets links to them.
- **Resource line** at the bottom: CPU, load, RAM, disk — of this machine or of the remote one in the active SSH session.
- **Session recording** to a text file with the ⏺ button.
- **Command palette** `Ctrl+Shift+P`: sections, clusters, hosts, notes, passwords, command history, snippets with `{{name}}` parameters.
- **Fish-style suggestions** while typing: the rest of the command in grey from bash/zsh history and code blocks in notes, `→` accepts.
- **Ctrl+click** on a path in the output opens the file at the line; on an address (`http://0.0.0.0:8000`, a short host name, a private IP inside an SSH session) OpsDeck opens it, raising an `ssh -L` tunnel when needed.
- **"Open folder in web"**: serves the current folder of an SSH session with `python3 -m http.server` on the host's 127.0.0.1 and opens it through an `ssh -L` tunnel — pick up files without sftp.
- **Highlighting** of the command being typed and of output (ERROR/WARN, pod statuses, IPs, links), a **files panel** with git status.
- **Font** and **right mouse button** (menu, PuTTY-style paste, or Windows Terminal-style "copy selection, otherwise paste") — ⚙ → Terminal.

### Local AI
- `Ctrl+Shift+K`: describe what to do in words and get a command that takes your notes and history into account.
- Runs on llama.cpp, installed from Settings if you want it, works offline: the light Qwen2.5-Coder 1.5B (≈1.1 GB) by default, Qwen3.5 4B/9B, Qwen3.8 27B and Qwen3.6 35B-A3B for powerful machines, or your own `.gguf`. Settings show for each model whether **this computer can run it** (★ the strongest that fits, ⚠ tight on memory or slow without a GPU, ✕ won't run) and refuse to start a download that won't fit on disk. GPU acceleration: Vulkan on Linux/Windows, Metal on Mac. Context size is selectable (16384 tokens by default).
- Or your own server with an OpenAI-compatible API — Ollama, vLLM, LM Studio (the key is kept in the system password store).
- **Knowledge base**: built-in cheat sheets for kubectl, helm, docker, systemd, terraform, git, ssh, jq, networking, disks, nginx, PostgreSQL, MySQL, ClickHouse, Kafka, Redis, Vault, PromQL, ansible, Yandex Cloud, VK Cloud and certificates (24 topics, over 250 commands). When a request matches a topic, the verified commands go into the model's prompt — real flags, not made-up ones. Your own commands go into `knowledge.md` next to the settings and come first.
- **Chat with the local AI** in the AI panel: up to 8 tabs, each can be bound to a terminal tab (its folder and shell) or to a server from the SSH list. Conversations are kept between launches on this computer only (`ai-chats.json`, mode `0600`; can be turned off in ⚙ → Local AI).

### AI agent
- The agent goes to the host itself: picks a command, runs it, reads the output and takes the next step — until it reaches a conclusion or runs out of steps. Every step is visible: host, command, "read" or "change", exit code and output. Started from the AI panel with the **Investigation** checkbox, "Stop" interrupts between steps.
- **Access level per host**: stay away / read only / change with permission / change freely. On a read-only host a changing command doesn't run at all; a change is shown as the exact command line and goes nowhere without a click.
- **Never runs**, at any level: redirections and compound commands (`>`, `;`, `&&`, backticks), interpreters (`sh`, `bash`, `python`, `awk`, `nc`) and the irreversible (`rm`, `dd`, `mkfs`, `reboot`, `passwd`). Arguments are checked too: `sysctl -w`, `ip link set`, `sort -o` count as changes. `sudo` is off by a separate checkbox.
- **Your own rules** in three lists (count as reading, always ask, forbid completely) and a log of every command run. The backend re-checks the policy right before `ssh`, and output from hosts is treated as data, not instructions.
- **AI context for hosts**: a note on what runs on a server and what matters ("PostgreSQL 16, orders DB; backups at 03:00; don't restart without approval") goes to the agent and the chat as information.
- The agent's model is chosen separately: the chat's model or your own external server.

### Kubernetes (Lens-style)
- Its own kubeconfig store (your `~/.kube/config` is not changed): import selected contexts, paste YAML, drag & drop files.
- Live tables (watch), CPU/RAM from metrics-server, requests/limits next to usage, any CRD with columns like `kubectl get`, label filter like `kubectl -l`.
- **Problems and checks**: two tables at the top of the list — what is broken now (CrashLoopBackOff, OOMKilled, image pull errors, unschedulable pods, missing Secrets and ConfigMaps) and what is configured unsafely, with a "how to fix" hint. Nothing has to be installed in the cluster.
- Pod logs and logs of **all pods** of a Deployment/StatefulSet/DaemonSet/Job at once, with filters, a timeline chart of errors and warnings and saving to a file; a "Details" tab with links to related objects; the object's pods as a tab; YAML with server-side apply.
- Shell, node shell (`kubectl debug`), port-forward, scale, restart, delete; multi-select and bulk delete; several namespaces as chips; Helm releases (values, history, rollback) and Argo CD Applications (sync/refresh). Keyboard navigation.
- **Read-only** mode for production contexts — the backend blocks changes. A lost connection is shown as such, not passed off as fresh data.

### Databases
- PostgreSQL, MySQL/MariaDB, ClickHouse, Redis, MongoDB: connect by address and port, password from keyring, KeePass or Passbolt, TLS.
- Structure tree (databases → schemas → tables → columns and indexes), a query editor with history, a results table, copy to CSV/JSON.
- **Read-only** mode for production databases: PostgreSQL and ClickHouse forbid writes on the server side.

### IDE and git
- Editor with highlighting (Terraform/HCL, YAML, JSON, TS/JS, Python, Go, Rust, SQL, Shell, Dockerfile…), file icons, project tree; several projects as chips, each with its own tabs.
- YAML/JSON/Terraform errors right in the code, `terraform fmt` on save; **project-wide search** (`Ctrl+Shift+F`), text or regex.
- **Pipeline graph** for `.gitlab-ci.yml` and `.github/workflows`: stages and jobs; pick the event, branch, changed files and variables and see what will run, what is manual and what won't run — before you push. `include: local`, `extends`, YAML anchors and `!reference` are resolved.
- Git panel: commit graph of all branches, diffs, branches (switch, create, merge, delete), fetch/pull/push, commit; lines not yet pushed are marked. A mini console in the project folder.

### Web panels and alerts
- Grafana, ArgoCD, GitLab and any sites — **as tabs inside the window** with automatic login (password from keyring, KeePass or Passbolt).
- **Alerts** 🔔: OpsDeck polls Grafana Alerting, Prometheus Alertmanager, Zabbix 6.0+ and JSON feeds of your AI analyzers itself — nothing has to be exposed to your machine. Desktop notifications, history, links to dashboards/silences, alert analysis in AI.
- **Your own AI analyzer** of logs and alerts can push findings to `127.0.0.1` with a token — the app has a ready guide and a `curl` example.

### Hosts and clouds
- **SSH**: profiles (key, jump host, password from KeePass or Passbolt), hosts from `~/.ssh/config`, groups, double click connects, a warning and a one-click fix when ssh would reject a key because of its permissions.
- **Host monitoring**: a board of SSH hosts — CPU, load, RAM, disk, uptime, coloured by the worst value; metrics are taken by key or through an already open session, one connection per host.
- **Files on hosts**: two panes — this machine or a host over SSH; download, upload, create a folder, rename, delete. Host → host goes through `scp -3`, OpsDeck holds both connections. Uses system `sftp` and `scp`, so `~/.ssh/config`, ProxyJump and keys apply; key login only.
- **Yandex Cloud**: instances (state, configuration, addresses, start/stop/restart, SSH in one click), networks and subnets, security groups with readable rules, public addresses, service accounts with roles and billing accounts. Works through the `yc` CLI and its profiles (`yc init`) — OpsDeck stores no tokens or service account keys.
- **VK Cloud**: instances, networks, security groups, floating IPs and project roles through persistent OpenStack SDK sessions and your `clouds.yaml`; balance and expense reports through the VK Cloud Billing API. Credentials remain in your OpenStack configuration; tokens are reused only in memory. Install `openstacksdk` in the same Python environment as `python-openstackclient`.
- **MikroTik**: WinBox and SSH in one click, import of saved routers from WinBox.
- **Network and DNS**: ping, mtr, traceroute, dig, nslookup; a host port scan (open/closed/filtered and what answers) and the ports this machine listens on, with processes.

### Everything else
- **Modules**: the ⊞ button in the left column turns sections on and off — keep only what you need. A new install has Terminal, Kubernetes, SSH, KeePass and Notes on; disabled sections are not loaded.
- **Separate windows**: any section opens in its own window (right click on its icon, ↗ or the palette); a terminal tab moves between windows together with its live session — same shell, same `cd`, a running `ssh` or `top` stays.
- **KeePass** (.kdbx): read only, the database lives in memory only; stays open until OpsDeck closes (or auto-locks) and picks up file changes. Passwords are copied with automatic clipboard clearing and serve every section.
- **Passbolt** (5.x): read only — login with an account kit, TOTP or Yubikey as the second factor, records with folders and search, copy login and password, palette. A password is requested from the server only when used (Passbolt logs every access), decrypted data lives in memory until lock.
- **Notes**: several vaults (your own or an Obsidian vault), folder tree with drag and drop, tags, search, a Markdown editor.
- **Tasks and reminders**: tasks as lines in notes (Obsidian Tasks format) with a description and subtasks, a combined list by due date, a calendar, reminder pop-ups with "snooze".
- **Moving to another computer**: ⚙ → export/import of settings, hosts, panels, databases, snippets, kubeconfig and notes into an archive (passwords are not included).

Every section has a **!** button — built-in help: how it works, what to click, hotkeys.

**Interface languages:** English and Russian (⚙ → Language; defaults to the system language).

---

## Installation

### System requirements

| OS | Versions | Notes |
|---|---|---|
| **Linux** (x64, ARM64) | Ubuntu 22.04+ (Mint 21+, Pop!_OS 22.04+), Debian 12+, Fedora 36+, openSUSE Tumbleweed, Arch/Manjaro | Needs glibc 2.35+ and WebKitGTK 4.1. **Not supported:** Ubuntu 20.04, Debian 11, RHEL/Alma/Rocky 9 (glibc 2.34). |
| **Windows** (x64) | Windows 10 and 11 | Needs WebView2: Windows 11 and an updated Windows 10 already have it, otherwise the installer downloads it. Windows 7/8 are not supported. |
| **macOS** | Intel: 10.13 High Sierra+; Apple Silicon (M1–M4): 11 Big Sur+ | Builds are not signed yet — see below. |

The local AI (optional, installed from ⚙) uses [llama.cpp](https://github.com/ggml-org/llama.cpp) builds and may need a newer system; if it doesn't start, the rest of OpsDeck works as usual. Models take from ≈1.1 GB (the default one, ≈1.5 GB of free memory while running) to ≈22 GB of disk; Settings show whether a model suits this computer.

### Prebuilt packages
Installers for Linux (`.deb`, `.rpm`, `.AppImage`), Windows (`.msi`, `.exe`) and macOS (`.dmg`) are published in [**Releases**](https://github.com/LeoAlecksey/opsdeck/releases) and built by GitHub Actions for every `v*` tag (see [CI builds](#ci-builds)).

> macOS builds are not signed with an Apple certificate yet. If macOS says the app is "damaged" and offers to move it to the Bin, it isn't damaged — this is Gatekeeper's quarantine for downloaded unsigned apps. Drag OpsDeck to Applications and run in Terminal:
>
> ```bash
> xattr -cr /Applications/OpsDeck.app
> ```
>
> If macOS says it can't verify the developer: System Settings → Privacy & Security → "Open Anyway" at the bottom (on macOS 15+ right click → "Open" no longer helps).

### Building from source
You need [Rust](https://rustup.rs) (stable) and Node.js 20+.

```bash
git clone https://github.com/LeoAlecksey/opsdeck.git && cd opsdeck
```

**Linux (Debian/Ubuntu)** — system libraries:
```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev build-essential
```
**Windows** — WebView2 (built into Windows 10/11) and Visual Studio Build Tools (C++). **macOS** — Xcode Command Line Tools.

```bash
npm install
npm run tauri dev      # development mode
npm run tauri build    # installers → src-tauri/target/release/bundle/
```

Optional external programs: `kubectl`, `helm`, `ssh`/`sftp`/`scp`, `yc`, `mtr`/`traceroute`/`dig`, WinBox, KeePassXC, `claude`/`codex`/`gemini`/`aider`/`opencode` — OpsDeck uses them if they are installed.

---

## Quick start

1. **Kubernetes**: section ☸ → **＋** → tick the contexts you need from `~/.kube/config`. Turn on 🔒 for production.
2. **Grafana and alerts**: section ◎ → **＋ Add** → type Grafana, URL, "token" auth (a service account with the Viewer role) → **Save and check**. Alerts appear in 🔔.
3. **Terminal + AI**: `Ctrl+Shift+I` opens the AI panel, `Ctrl+Shift+A` sends the selection, `Ctrl+Shift+P` is the palette, `Ctrl+Shift+K` is the local AI.
4. **Local AI and agent**: ⚙ → Local AI → pick a model → "Install"; for investigations turn on the "AI agent" module in ⊞ and set access levels for hosts.
5. **KeePass, notes, WinBox**: paths are picked up automatically, check them in ⚙.

---

## Updates and releases

OpsDeck updates itself: on launch (or with the button in ⚙ → Updates) it checks GitHub Releases, and if there is a new version ↑ appears on ⚙; **"Update and restart"** downloads it, **verifies the signature** and installs it (Windows, macOS, Linux: AppImage, `.deb`, `.rpm` — for packages the system asks for a password). In ⚙ → Updates → "Other versions" you can go back to any previous version.

A release takes two steps (`master` accepts changes only through a pull request):

```bash
# 1. on dev: bump the version in package.json, tauri.conf.json, Cargo.toml and Cargo.lock, commit and push dev
npm run release -- 0.9.0
# then a PR dev → master, checks, merge

# 2. on master: an annotated tag v0.9.0 with the release notes
npm run release -- 0.9.0 @docs/releases/0.9.0.md
```

GitHub Actions builds every platform, signs the updates and **publishes the release** with `latest.json` — installed copies see it on their next check. Release notes are written in advance in `docs/releases/`.

Signing: updates are signed with a private key (minisign) from the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; the public key is embedded in `tauri.conf.json`, and the app won't install a file with someone else's signature. The key is created with `npx tauri signer generate -w ~/.tauri/opsdeck.key`. **Keep the key and its password safe** (for example, in KeePass): without them you can't release an update for already installed copies.

## CI builds

`.github/workflows/build.yml` builds on **native runners** — each platform on its own OS and architecture:

| Runner | Output |
|---|---|
| `ubuntu-22.04` (x64), `ubuntu-22.04-arm` (arm64) | `.deb`, `.rpm`, `.AppImage` |
| `windows-2025` (x64) | `.msi`, NSIS installer `.exe` |
| `macos-26` (Apple Silicon; the Intel build is made there too, with `--target x86_64-apple-darwin`) | `.dmg`, `.app` |

- Push to `main`/`master` (happens only on a release): checks and a build of every platform without publishing — it also fills the Rust cache the next release uses.
- Pull request to `master`: checks (TypeScript, `npm audit`, `cargo audit`) and a quick linux-x64 build; the installer is in the run's artifacts.
- The `dev` branch isn't built by itself; a manual run (Run workflow) builds linux-x64 or, with a checkbox, every platform.
- A `v*` tag: every platform; the release is assembled as a draft and **published** (with all installers, signed updates and `latest.json`) only after the checks, all builds and all tests have passed.
- **Tests** (on tags, pushes to master, PRs to master and manual runs): Rust tests on Linux, Windows and macOS (`cargo test --lib`); UI tests — vitest (`npm test`) and Playwright on demo data (`npm run test:ui`); end-to-end tests of the real app through tauri-driver on Linux and Windows (`tests/e2e`). Failed tests leave the release a draft.
- Windows on ARM isn't built: there are too few such users.
- Linux arm64 runners are free for public repositories; a private one may not have them on your plan — then remove `linux-arm64` from the platform list in the `plan` job.
- **Emergency rollback**: Actions → "Отозвать версию" (Withdraw version) → version number. The release becomes a pre-release, the previous stable one becomes "latest" again, and copies with the withdrawn version offer to go back to it.
- Dependabot (`.github/dependabot.yml`) sends monthly grouped dependency PRs to `dev` (major versions by hand).

---

## Architecture

```
src/                  UI (TypeScript, no framework)
  main.ts             shell: list of sections, left column, mounting on demand, single-section windows
  modules/            sections: terminal, k8s, code, db, connectors (web panels), alerts, aichat, ai-agents, …
src-tauri/src/        Rust backend, a module per section
  pty.rs              terminals (portable-pty) + shell integration (OSC 133)
  k8s.rs              Kubernetes (kube-rs): lists, watch, logs, Helm, CRD
  ai.rs, aichat.rs    local AI (llama.cpp): models, command suggestions, chat
  agent.rs            AI agent: the command policy, re-checked right before ssh
  embed.rs            web panels embedded in tabs
  alerts.rs           alert and AI-finding collection
  ide.rs              bridge for Claude Code (MCP over WebSocket, 127.0.0.1)
  store.rs            JSON in ~/.config/opsdeck + secrets in the OS keyring
  keepass.rs, passbolt.rs, ssh.rs, sftp.rs, yc.rs, db.rs, notes.rs, tasks.rs, …
```

User data: `~/.config/opsdeck/` (modes 600/700, atomic writes), secrets — in the system store (Secret Service / Keychain / Credential Manager).

---

## Security

- Secrets live only in the system store or KeePass/Passbolt; the KeePass database and Passbolt records are decrypted in memory only; passwords in the clipboard are wiped after 30 s.
- OpsDeck doesn't listen on external interfaces: the Claude Code bridge and the AI-findings receiver are `127.0.0.1` only, with a token, protected from browser requests and DNS rebinding.
- Embedded web pages have no access to the app's API; auto-login works only on the connector's address.
- A strict UI CSP, escaping of all external data, Markdown through DOMPurify.
- External programs are started without a shell, arguments are validated; importing a kubeconfig with `exec` shows the commands it will run.
- The AI agent runs only what its policy allows; the policy is checked again in the backend before `ssh`, and output from hosts and models is data, not instructions.
- In CI — `npm audit` and `cargo audit` on every build, CodeQL, Dependabot for dependencies.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

---

## Known limitations

- Web panels are native webviews on top of the UI: while focus is inside a panel, OpsDeck hotkeys don't work. If embedding misbehaves, start with `OPSDECK_NO_EMBED=1` — panels will open in separate windows.
- SSO login (Keycloak, Google) and 2FA in web panels are done by hand once.
- Command blocks work in bash and zsh; in PowerShell the terminal works without blocks. Windows usually has no `mtr` and `dig`.
- WinBox accepts a password only as a command-line argument — while it runs, the password is visible in your user's process list.
- Files on hosts and monitoring need key-based SSH login.

---

## Contributing

[Issues](https://github.com/LeoAlecksey/opsdeck/issues) and pull requests are welcome — how to build, test and send changes is in [CONTRIBUTING.md](CONTRIBUTING.md). Pull requests go to the `dev` branch.

## Author and support

- The author's Telegram channel: [@sys_admin_expert](https://t.me/sys_admin_expert)
- If OpsDeck is useful to you, you can [support the project](https://yoomoney.ru/to/4100119645604976) (YooMoney). Thank you!

## License

[MIT](LICENSE) © 2026 [LeoAlecksey](https://github.com/LeoAlecksey)

---

<a id="ru"></a>

# OpsDeck — по-русски

[English](#en) · **Русский**

**Единая рабочая панель DevOps-инженера**: терминал с AI рядом и локальной моделью, ИИ-агент, который сам расследует проблемы на хостах по вашим правилам, Kubernetes, базы данных, IDE с git, Grafana/ArgoCD/GitLab во вкладках, алерты, заметки с задачами и напоминаниями, KeePass и Passbolt, SSH, мониторинг хостов, файлы между хостами, Yandex Cloud и MikroTik — в одном нативном приложении для Linux, Windows и macOS.

🌐 **Сайт с обзором и инструкцией:** https://leoalecksey.github.io/opsdeck/ ([English](https://leoalecksey.github.io/opsdeck/en/))

Стек: **Rust + [Tauri 2](https://tauri.app)** (бэкенд), TypeScript + Vite (интерфейс), [xterm.js](https://xtermjs.org) (терминал), [kube-rs](https://kube.rs) (Kubernetes), [llama.cpp](https://github.com/ggml-org/llama.cpp) (локальный ИИ).

---

## Возможности

### Терминал «как Warp» + AI рядом
- Вкладки и сплиты, настоящий shell (bash/zsh/PowerShell, на Windows — WSL и Git Bash), цветовые схемы.
- **Блоки команд**: у каждой команды — код выхода и время, панель действий (скопировать команду/вывод, сохранить как сниппет, отправить в AI), плашка «спросить AI» при ошибке, навигация по командам.
- **AI-панель** справа: Claude Code, Codex, Gemini, Aider или OpenCode в своём терминале (до трёх рядом); выделенный текст или вывод команды отправляется туда одной клавишей.
- **Интеграция с Claude Code как IDE**: `claude`, запущенный в OpsDeck, подключается к нему сам (MCP по WebSocket на 127.0.0.1) — видит выделение в заметках и получает ссылки на них.
- **Строка ресурсов** внизу: CPU, load, RAM, диск — этой машины или удалённой в активной SSH-сессии.
- **Запись сессии** в текстовый файл кнопкой ⏺.
- **Палитра команд** `Ctrl+Shift+P`: разделы, кластеры, хосты, заметки, пароли, история команд, сниппеты с параметрами `{{имя}}`.
- **Подсказка при наборе**, как в fish: продолжение команды серым из истории bash/zsh и блоков кода в заметках, `→` — принять.
- **Ctrl+клик** по пути в выводе открывает файл на строке; по адресу (`http://0.0.0.0:8000`, короткое имя хоста, частный IP внутри SSH-сессии) — открывает его, при необходимости поднимая туннель `ssh -L`.
- **«Открыть папку в web»**: текущая папка SSH-сессии раздаётся `python3 -m http.server` на 127.0.0.1 хоста и открывается через туннель `ssh -L` — забрать файлы без sftp.
- **Подсветка** команды при наборе и вывода (ERROR/WARN, статусы подов, IP, ссылки), **панель файлов** с git-статусом.
- **Шрифт** и **правая кнопка мыши** (меню, вставка как в PuTTY или «копировать выделение, иначе вставить», как в Windows Terminal) — ⚙ → Терминал.

### Локальный ИИ
- `Ctrl+Shift+K`: опишите словами, что сделать, — получите команду с учётом ваших заметок и истории.
- Работает на llama.cpp, ставится из настроек по желанию и работает без интернета: лёгкая Qwen2.5-Coder 1.5B (≈1,1 ГБ) по умолчанию, Qwen3.5 4B/9B, Qwen3.8 27B и Qwen3.6 35B-A3B для мощных ПК или свой файл `.gguf`. В настройках у каждой модели видно, **потянет ли её этот компьютер** (★ самая сильная из подходящих, ⚠ памяти впритык или медленно без видеокарты, ✕ не потянет), а загрузка, которой не хватит места на диске, не начнётся. Ускорение на видеокарте: Vulkan на Linux/Windows, Metal на Mac. Размер контекста выбирается (по умолчанию 16384 токена).
- Или свой сервер с OpenAI-совместимым API — Ollama, vLLM, LM Studio (ключ хранится в системном хранилище паролей).
- **База знаний**: встроенные шпаргалки по kubectl, helm, docker, systemd, terraform, git, ssh, jq, сетям, дискам, nginx, PostgreSQL, MySQL, ClickHouse, Kafka, Redis, Vault, PromQL, ansible, Yandex Cloud, VK Cloud и сертификатам (24 темы, больше 250 команд). Когда запрос похож на тему, проверенные команды уходят в подсказку модели — флаги настоящие, а не выдуманные. Свои команды дописываются в `knowledge.md` рядом с настройками и идут первыми.
- **Чат с локальным ИИ** в AI-панели: до 8 вкладок, каждую можно привязать к вкладке терминала (её папка и оболочка) или к серверу из списка SSH. Разговоры сохраняются между запусками только на этом компьютере (`ai-chats.json`, права `0600`; выключается в ⚙ → Локальный ИИ).

### ИИ-агент
- Агент сам ходит на хост: выбирает команду, выполняет её, читает вывод и делает следующий шаг — до итога или до конца отведённых шагов. Каждый шаг виден: хост, команда, «чтение» или «изменение», код возврата и вывод. Запускается из AI-панели галочкой **Расследование**, «Стоп» прерывает между шагами.
- **Уровень доступа на каждый хост**: не ходить / только чтение / менять с разрешения / менять без вопросов. На хосте «только чтение» изменяющая команда не выполнится вовсе; изменение показывается точной строкой и без нажатия не идёт никуда.
- **Не выполнится ни при каком уровне**: перенаправления и составные команды (`>`, `;`, `&&`, обратные кавычки), интерпретаторы (`sh`, `bash`, `python`, `awk`, `nc`) и необратимое (`rm`, `dd`, `mkfs`, `reboot`, `passwd`). Аргументы тоже проверяются: `sysctl -w`, `ip link set`, `sort -o` считаются изменением. `sudo` выключен отдельной галочкой.
- **Свои правила** тремя списками (считать чтением, спрашивать всегда, запретить) и журнал каждой выполненной команды. Бэкенд проверяет политику ещё раз прямо перед `ssh`, а вывод с хостов считается данными, а не указаниями.
- **Контекст для ИИ у хостов**: что на сервере крутится и что важно («PostgreSQL 16, база заказов; бэкапы в 03:00; без согласования не перезапускать») — уходит агенту и чату как сведения.
- Модель агента выбирается отдельно: та же, что у чата, или свой внешний сервер.

### Kubernetes (в духе Lens)
- Собственное хранилище kubeconfig (ваш `~/.kube/config` не меняется): импорт выбранных контекстов, вставка YAML, drag & drop файлов.
- Живые таблицы (watch), CPU/RAM из metrics-server, requests/limits рядом с потреблением, любые CRD с колонками как у `kubectl get`, фильтр по меткам как у `kubectl -l`.
- **Проблемы и проверки**: две таблицы в начале списка — что сломано сейчас (CrashLoopBackOff, OOMKilled, образ не скачивается, под не назначается, ссылки на несуществующие Secret и ConfigMap) и что сделано небезопасно, с подсказкой «как исправить». В кластер ничего ставить не нужно.
- Логи пода и **сразу всех подов** Deployment/StatefulSet/DaemonSet/Job с фильтрами, графиком ошибок и предупреждений по времени и сохранением в файл; вкладка «Детали» со ссылками на связанные объекты; поды объекта отдельной вкладкой; YAML с server-side apply.
- Shell, shell на узле (`kubectl debug`), port-forward, scale, restart, delete; мультивыбор и массовое удаление; несколько namespace плашками; Helm-релизы (values, история, rollback) и Argo CD Applications (sync/refresh). Управление с клавиатуры.
- Режим **«только чтение»** для продовых контекстов — изменения блокирует бэкенд. Обрыв связи с кластером виден, прежний снимок не выдаётся за свежий.

### Базы данных
- PostgreSQL, MySQL/MariaDB, ClickHouse, Redis, MongoDB: подключение по адресу и порту, пароль из keyring, KeePass или Passbolt, TLS.
- Дерево структуры (базы → схемы → таблицы → колонки и индексы), редактор запросов с историей, таблица результатов, копирование в CSV/JSON.
- Режим **«только чтение»** для прод-баз: PostgreSQL и ClickHouse запрещают запись на стороне сервера.

### IDE и git
- Редактор с подсветкой (Terraform/HCL, YAML, JSON, TS/JS, Python, Go, Rust, SQL, Shell, Dockerfile…), свои иконки файлов, дерево проекта; несколько проектов плашками, у каждого свои вкладки.
- Ошибки YAML/JSON/Terraform прямо в коде, `terraform fmt` при сохранении; **поиск по всему проекту** (`Ctrl+Shift+F`), текст или регулярное выражение.
- **Граф пайплайна** для `.gitlab-ci.yml` и `.github/workflows`: стадии и задачи; выберите событие, ветку, изменённые файлы и переменные — и видно, что запустится, что только вручную, а что нет, ещё до пуша. Раскрываются `include: local`, `extends`, якоря YAML и `!reference`.
- Панель git: граф коммитов всех веток, диффы, ветки (переключить, создать, слить, удалить), fetch/pull/push, коммит; строки, ещё не отправленные в удалённую ветку, помечены. Мини-консоль в папке проекта.

### Веб-панели и алерты
- Grafana, ArgoCD, GitLab и любые сайты — **вкладками внутри окна** с автоматическим входом (пароль из keyring, KeePass или Passbolt).
- **Алерты** 🔔: OpsDeck сам опрашивает Grafana Alerting, Prometheus Alertmanager, Zabbix 6.0+ и JSON-ленты ваших AI-анализаторов — на машину ничего не нужно пробрасывать. Уведомления на рабочем столе, история, ссылки на панели/silence, разбор алерта в AI.
- **Свой AI-анализатор** логов и алертов может присылать находки на `127.0.0.1` по токену — в приложении есть готовая инструкция и пример `curl`.

### Хосты и облака
- **SSH**: профили (ключ, jump-хост, пароль из KeePass или Passbolt), хосты из `~/.ssh/config`, группы, подключение двойным кликом, предупреждение и исправление в один клик, если ssh отвергнет ключ из-за прав на файл.
- **Мониторинг хостов**: доска SSH-хостов — CPU, load, RAM, диск, аптайм, цвет по худшему показателю; метрики снимаются по ключу или через уже открытую сессию, одно соединение на хост.
- **Файлы на хостах**: две панели — своя машина или хост по SSH; скачать, загрузить, создать папку, переименовать, удалить. Перенос хост → хост идёт через `scp -3`, оба соединения ведёт OpsDeck. Работает системными `sftp` и `scp`, то есть с `~/.ssh/config`, ProxyJump и ключами; вход только по ключу.
- **Yandex Cloud**: машины (состояние, конфигурация, адреса, включить/выключить/перезагрузить, SSH в один клик), сети и подсети, группы безопасности с правилами по-человечески, публичные адреса, сервисные аккаунты с правами и платёжные аккаунты. Работает через CLI `yc` и его профили (`yc init`) — ни токенов, ни ключей сервисных аккаунтов OpsDeck не хранит.
- **VK Cloud**: машины, сети, группы безопасности, плавающие адреса и роли через постоянные сессии OpenStack SDK и ваш `clouds.yaml`; баланс и детализация расходов через Billing API VK Cloud. Учётные данные остаются в конфигурации OpenStack, токены повторно используются только в памяти. Установите `openstacksdk` в том же Python-окружении, что и `python-openstackclient`.
- **MikroTik**: WinBox и SSH в один клик, импорт сохранённых роутеров из WinBox.
- **Сеть и DNS**: ping, mtr, traceroute, dig, nslookup; скан портов хоста (открыт/закрыт/фильтруется и что отвечает) и список портов, которые слушает эта машина, с процессами.

### Остальное
- **Модули**: кнопка ⊞ в колонке слева включает и выключает разделы галочками — оставьте только нужные. В новой установке включены Терминал, Kubernetes, SSH, KeePass и Заметки; выключенные разделы не загружаются.
- **Отдельные окна**: любой раздел открывается в своём окне (правый клик по иконке, ↗ или палитра); вкладка терминала переезжает между окнами вместе с живой сессией — та же оболочка, тот же `cd`, запущенный `ssh` или `top` остаются.
- **KeePass** (.kdbx): только чтение, база лишь в памяти; остаётся открытой до закрытия OpsDeck (или автоблокировка) и сама подтягивает изменения файла. Пароли копируются с автоочисткой буфера и служат источником для всех разделов.
- **Passbolt** (5.x): только чтение — вход по account kit, второй фактор TOTP или Yubikey, список записей с папками и поиском, копирование логина и пароля, палитра. Пароль запрашивается с сервера только при использовании (Passbolt пишет каждое обращение в журнал), расшифрованное — лишь в памяти до блокировки.
- **Заметки**: несколько хранилищ (свои или Obsidian vault), дерево папок с перетаскиванием, теги, поиск, редактор Markdown.
- **Задачи и напоминания**: задачи строками в заметках (формат Obsidian Tasks) с описанием и подзадачами, общий список по срокам, календарь, всплывающие напоминания с «отложить».
- **Перенос на другой компьютер**: ⚙ → экспорт и импорт настроек, хостов, панелей, баз, сниппетов, kubeconfig и заметок архивом (пароли в него не попадают).

В каждом разделе есть кнопка **!** — встроенная подсказка: как работает, что где нажимать, горячие клавиши.

**Языки интерфейса:** русский и английский (⚙ → Язык; по умолчанию — как в системе).

---

## Установка

### Системные требования

| ОС | Версии | Примечания |
|---|---|---|
| **Linux** (x64, ARM64) | Ubuntu 22.04+ (Mint 21+, Pop!_OS 22.04+), Debian 12+, Fedora 36+, openSUSE Tumbleweed, Arch/Manjaro | Нужны glibc 2.35+ и WebKitGTK 4.1. **Не подходят:** Ubuntu 20.04, Debian 11, RHEL/Alma/Rocky 9 (glibc 2.34). |
| **Windows** (x64) | Windows 10 и 11 | Нужен WebView2: в Windows 11 и обновлённой Windows 10 он уже есть, иначе установщик скачает его сам. Windows 7/8 не поддерживаются. |
| **macOS** | Intel: 10.13 High Sierra+; Apple Silicon (M1–M4): 11 Big Sur+ | Сборки пока не подписаны — см. ниже. |

Локальный ИИ (необязательный, ставится из ⚙) использует сборки [llama.cpp](https://github.com/ggml-org/llama.cpp) и может требовать систему новее; если он не запустится, остальное OpsDeck работает как обычно. Модели занимают от ≈1,1 ГБ на диске (модель по умолчанию, ≈1,5 ГБ свободной памяти во время работы) до ≈22 ГБ; подходит ли модель этому компьютеру, видно в настройках.

### Готовые сборки
Установщики для Linux (`.deb`, `.rpm`, `.AppImage`), Windows (`.msi`, `.exe`) и macOS (`.dmg`) публикуются в [**Releases**](https://github.com/LeoAlecksey/opsdeck/releases) и собираются GitHub Actions на каждый тег `v*` (см. [Сборка в CI](#сборка-в-ci)).

> macOS-сборки пока не подписаны сертификатом Apple. Если при запуске macOS пишет, что приложение «повреждено» и предлагает переместить его в корзину, — оно не повреждено, это карантин Gatekeeper для скачанных неподписанных программ. Перетащите OpsDeck в «Программы» и выполните в Терминале:
>
> ```bash
> xattr -cr /Applications/OpsDeck.app
> ```
>
> Если macOS пишет, что не может проверить разработчика: «Системные настройки» → «Конфиденциальность и безопасность» → внизу «Всё равно открыть» (на macOS 15+ правый клик → «Открыть» больше не помогает).

### Сборка из исходников
Нужны [Rust](https://rustup.rs) (stable) и Node.js 20+.

```bash
git clone https://github.com/LeoAlecksey/opsdeck.git && cd opsdeck
```

**Linux (Debian/Ubuntu)** — системные библиотеки:
```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev build-essential
```
**Windows** — WebView2 (есть в Windows 10/11) и Visual Studio Build Tools (C++). **macOS** — Xcode Command Line Tools.

```bash
npm install
npm run tauri dev      # режим разработки
npm run tauri build    # установщики → src-tauri/target/release/bundle/
```

Необязательные внешние программы: `kubectl`, `helm`, `ssh`/`sftp`/`scp`, `yc`, `mtr`/`traceroute`/`dig`, WinBox, KeePassXC, `claude`/`codex`/`gemini`/`aider`/`opencode` — OpsDeck использует их, если они установлены.

---

## Быстрый старт

1. **Kubernetes**: раздел ☸ → **＋** → отметьте нужные контексты из `~/.kube/config`. Для прода включите 🔒.
2. **Grafana и алерты**: раздел ◎ → **＋ Добавить** → тип Grafana, URL, авторизация «токен» (Service account с ролью Viewer) → **Сохранить и проверить**. Алерты появятся в 🔔.
3. **Терминал + AI**: `Ctrl+Shift+I` открывает AI-панель, `Ctrl+Shift+A` отправляет выделение, `Ctrl+Shift+P` — палитра, `Ctrl+Shift+K` — локальный ИИ.
4. **Локальный ИИ и агент**: ⚙ → Локальный ИИ → выберите модель → «Установить»; для расследований включите модуль «ИИ-агент» в ⊞ и задайте уровни доступа хостам.
5. **KeePass, заметки, WinBox**: пути подхватываются автоматически, проверить можно в ⚙.

---

## Обновления и выпуск версий

OpsDeck обновляется сам: при запуске (или кнопкой в ⚙ → «Обновления») проверяет GitHub Releases, и если есть новая версия — на ⚙ появляется ↑, а кнопка **«Обновить и перезапустить»** скачивает, **проверяет подпись** и ставит обновление (Windows, macOS, Linux: AppImage, `.deb`, `.rpm` — для пакетов система спросит пароль). В ⚙ → Обновления → «Другие версии» можно вернуться на любую прошлую.

Выпуск версии — в два шага (в `master` изменения попадают только через pull request):

```bash
# 1. на dev: поднять версию в package.json, tauri.conf.json, Cargo.toml и Cargo.lock, закоммитить и запушить dev
npm run release -- 0.9.0
# дальше PR dev → master, проверки, вливание

# 2. на master: аннотированный тег v0.9.0 с заметками к релизу
npm run release -- 0.9.0 @docs/releases/0.9.0.md
```

GitHub Actions собирает все платформы, подписывает обновления и **публикует релиз** с `latest.json` — установленные копии увидят его при следующей проверке. Заметки к релизу пишутся заранее в `docs/releases/`.

Подпись: обновления подписываются приватным ключом (minisign) из секретов репозитория `TAURI_SIGNING_PRIVATE_KEY` и `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; публичный ключ зашит в `tauri.conf.json`, и приложение не установит файл с чужой подписью. Ключ создаётся командой `npx tauri signer generate -w ~/.tauri/opsdeck.key`. **Храните ключ и пароль в надёжном месте** (например, в KeePass): без них выпустить обновление для уже установленных копий нельзя.

## Сборка в CI

`.github/workflows/build.yml` собирает на **нативных раннерах** — каждая платформа на своей ОС и архитектуре:

| Раннер | Что получается |
|---|---|
| `ubuntu-22.04` (x64), `ubuntu-22.04-arm` (arm64) | `.deb`, `.rpm`, `.AppImage` |
| `windows-2025` (x64) | `.msi`, установщик NSIS `.exe` |
| `macos-26` (Apple Silicon; сборка для Intel — там же, с `--target x86_64-apple-darwin`) | `.dmg`, `.app` |

- Пуш в `main`/`master` (бывает только при релизе): проверки и сборка всех платформ без публикации — она же заполняет кэш Rust, из которого следующий релиз берёт уже собранные зависимости.
- Pull request в `master`: проверки (TypeScript, `npm audit`, `cargo audit`) и быстрая сборка только linux-x64; установщик — в артефактах запуска (Actions → запуск → Artifacts).
- Ветка `dev` сама не собирается; ручной запуск (Run workflow) собирает linux-x64 или, с галкой, все платформы.
- Тег `v*`: все платформы, релиз собирается черновиком и **публикуется** (со всеми установщиками, подписанными обновлениями и `latest.json`) только после того, как прошли проверки, все сборки и все тесты.
- **Тесты** (на тегах, пушах в master, PR в master и ручном запуске): тесты Rust на Linux, Windows и macOS (`cargo test --lib`); тесты интерфейса — vitest (`npm test`) и Playwright на демо-данных (`npm run test:ui`); сквозные тесты настоящего приложения через tauri-driver на Linux и Windows (`tests/e2e`). Упали тесты — релиз остаётся черновиком.
- Windows на ARM не собирается: таких пользователей слишком мало.
- arm64-раннеры Linux бесплатны для публичных репозиториев; в приватном их может не быть на вашем тарифе — тогда уберите `linux-arm64` из списка платформ в job `plan`.
- **Аварийный откат**: если версия вышла с критической ошибкой — Actions → «Отозвать версию» → номер версии. Релиз становится pre-release, «последним» снова становится предыдущий стабильный; установленные копии с отозванной версией предложат вернуться на него.
- Dependabot (`.github/dependabot.yml`) раз в месяц присылает в `dev` общие PR с обновлениями зависимостей (мажорные версии — вручную).

---

## Архитектура

```
src/                  интерфейс (TypeScript, без фреймворка)
  main.ts             каркас: список разделов, колонка слева, монтирование по требованию, окна одного раздела
  modules/            разделы: terminal, k8s, code, db, connectors (веб-панели), alerts, aichat, ai-agents, …
src-tauri/src/        бэкенд на Rust, модуль на раздел
  pty.rs              терминалы (portable-pty) + интеграция shell (OSC 133)
  k8s.rs              Kubernetes (kube-rs): списки, watch, логи, Helm, CRD
  ai.rs, aichat.rs    локальный ИИ (llama.cpp): модели, подсказка команд, чат
  agent.rs            ИИ-агент: политика команд, проверяется ещё раз прямо перед ssh
  embed.rs            встраивание веб-панелей во вкладки
  alerts.rs           сбор алертов и находок AI
  ide.rs              мост для Claude Code (MCP по WebSocket, 127.0.0.1)
  store.rs            JSON в ~/.config/opsdeck + секреты в keyring ОС
  keepass.rs, passbolt.rs, ssh.rs, sftp.rs, yc.rs, db.rs, notes.rs, tasks.rs, …
```

Данные пользователя: `~/.config/opsdeck/` (права 600/700, атомарная запись), секреты — в системном хранилище (Secret Service / Keychain / Credential Manager).

---

## Безопасность

- Секреты — только в системном хранилище или KeePass/Passbolt; база KeePass и записи Passbolt расшифрованы лишь в памяти; пароли в буфере стираются через 30 с.
- OpsDeck не слушает внешние интерфейсы: мост для Claude Code и приём находок AI — только `127.0.0.1`, по токену, с защитой от запросов из браузера и DNS rebinding.
- Встроенные веб-страницы не имеют доступа к API приложения; автологин работает только на адресе коннектора.
- Строгая CSP интерфейса, экранирование всех внешних данных, Markdown через DOMPurify.
- Внешние программы запускаются без shell, аргументы валидируются; при импорте kubeconfig с `exec` показываются запускаемые им команды.
- ИИ-агент выполняет только то, что разрешает политика; она проверяется ещё раз в бэкенде перед `ssh`, а вывод с хостов и от моделей — данные, а не указания.
- В CI — `npm audit` и `cargo audit` на каждую сборку, CodeQL, Dependabot для зависимостей.

Нашли уязвимость? См. [SECURITY.md](SECURITY.md).

---

## Известные ограничения

- Веб-панели — нативные webview поверх интерфейса: пока фокус внутри панели, горячие клавиши OpsDeck не срабатывают. Если встраивание ведёт себя странно, запустите с `OPSDECK_NO_EMBED=1` — панели будут открываться отдельными окнами.
- SSO-вход (Keycloak, Google) и 2FA в веб-панелях проходятся вручную один раз.
- Блоки команд работают в bash и zsh; в PowerShell терминал работает без блоков. На Windows обычно нет `mtr` и `dig`.
- WinBox принимает пароль только аргументом командной строки — пока он запущен, пароль виден в списке процессов вашего пользователя.
- Файлам на хостах и мониторингу нужен вход по SSH-ключу.

---

## Участие

[Issues](https://github.com/LeoAlecksey/opsdeck/issues) и pull requests приветствуются — как собрать, проверить и прислать изменения, написано в [CONTRIBUTING.md](CONTRIBUTING.md). PR принимаются в ветку `dev`.

## Автор и поддержка

- Telegram-канал автора: [@sys_admin_expert](https://t.me/sys_admin_expert)
- Если OpsDeck пригодился — можно [поддержать проект](https://yoomoney.ru/to/4100119645604976) (ЮMoney). Спасибо!

## Лицензия

[MIT](LICENSE) © 2026 [LeoAlecksey](https://github.com/LeoAlecksey)
