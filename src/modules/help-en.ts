/** English version of the built-in guides ("!" buttons); same ids as in help.ts. */
const kbd = (k: string) => `<kbd>${k}</kbd>`;

export const HELP_EN: Record<string, { title: string; html: string }> = {
  terminal: {
    title: "Terminal & AI",
    html: `
      <h4>How it works</h4>
      <p>Every tab is a real shell (bash/zsh) with OpsDeck integration: each command becomes a <b>block</b> with its exit code and duration. On the right is the AI panel: Claude Code (or Codex/Gemini/Aider/OpenCode) runs there in its own terminal.</p>
      <h4>What's where</h4>
      <ul>
        <li><b>＋</b> — new tab (opens in the same folder), <b>◫ / ⊟</b> — split right / down. When there are more tabs than fit, scroll the tab bar with the mouse wheel.</li>
        <li>Hover a command to get the block toolbar: copy the command or its output, <b>★</b> save as a snippet, <b>⇢ AI</b> send the command with its output to AI.</li>
        <li>When a command fails, an <b>“ask AI”</b> bar appears at the bottom.</li>
        <li><b>⇢ to AI</b> — send the selected text; <b>AI ▸</b> — show/hide the AI panel, the model is chosen there.</li>
        <li><b>◆ Claude IDE</b> in the tab bar — Claude Code is connected to OpsDeck and sees selections in notes.</li>
        <li>Coloured marks on the scrollbar are commands (red — failed).</li>
        <li><b>⏺</b> — record the active pane to a text file (on/off); a red dot on the tab while recording. Files go to Documents/OpsDeck/sessions, <b>📂</b> next to ⏺ opens that folder. Passwords you type are not recorded — the terminal doesn't display them.</li>
        <li><b>A− 13 A+</b> — font size in all terminals (click the number — back to 13). Also ${kbd("Ctrl+=")} / ${kbd("Ctrl+-")} / ${kbd("Ctrl+0")} or ${kbd("Ctrl")}+mouse wheel over the terminal. The size is remembered.</li>
        <li><b>The bottom bar</b> — resources of the machine: this one, or the remote one when the active tab runs an SSH session (Linux hosts; metrics go over the same SSH connection, no second login).</li>
        <li><b>Highlighting</b>: while typing, the command is green if it exists and red if not (aliases and functions from your .bashrc/.zshrc count); flags, strings, $VARIABLES, | && ; and comments get their own colours. In the output: ERROR/WARN, pod states (Running, CrashLoopBackOff…), IPs, links and time. Turn off in ⚙ → Terminal or via the palette.</li>
        <li><b>📁 Files</b> (${kbd("Ctrl+Shift+B")}) — tree of the folder the shell is in (follows <code>cd</code>; ⌖ — stop following, double-click a folder — make it the root). Click a file — open it in the chosen editor (the built-in <b>OpsDeck IDE</b> by default); <b>Open in IDE</b> — the whole project (the git repository root). On a row: ↗ — in the IDE, ⎘ — paste the path into the terminal, ⤷ — cd. Colours show git status: yellow changed, green new, red deleted. External editors are detected (VS Code, Cursor, Zed, Sublime, JetBrains…; vim/nvim/helix open in a terminal tab), or “Custom command…”.</li>
        <li><b>Inline suggestion</b>: the rest of the command in grey, from this session, bash/zsh history and code blocks in notes. ${kbd("→")} or ${kbd("End")} — accept it all, ${kbd("Ctrl+→")} — one word. Turn off in ⚙ → Terminal.</li>
        <li><b>✦ AI</b> (${kbd("Ctrl+Shift+K")}) — <b>local AI</b>: describe in words what to do (“restart the api deployment in stage”) and get a command based on your notes and history. <b>Paste</b> (${kbd("Enter")}) puts it on the line without running, <b>Run</b> (${kbd("Ctrl+Enter")}) runs it. The model (Qwen2.5-Coder 1.5B by default) is chosen and installed in ⚙ → Local AI and runs only on this computer.</li>
        <li>${kbd("Ctrl")}+click a path in the output (e.g. <code>src/main.rs:42</code> from a compiler error) — open the file in the editor at that line.</li>
      </ul>
      <h4>Hotkeys</h4>
      <ul>
        <li>${kbd("Ctrl+Shift+T")} new tab, ${kbd("Ctrl+Shift+W")} close pane/tab</li>
        <li>${kbd("Alt+1")}…${kbd("Alt+9")} go to a tab by number (${kbd("Alt+9")} — the last one), ${kbd("Alt+←/→")} or ${kbd("Ctrl+Tab")} / ${kbd("Ctrl+Shift+Tab")} — previous / next tab</li>
        <li>${kbd("Ctrl+Shift+D")} / ${kbd("Ctrl+Shift+E")} split right / down (a WSL pane — into the same distribution), ${kbd("Ctrl+Shift+←/→")} between panes</li>
        <li>${kbd("Ctrl+Shift+↑/↓")} to the previous / next command</li>
        <li>${kbd("Ctrl+=")} / ${kbd("Ctrl+-")} / ${kbd("Ctrl+0")} font size</li>
        <li>${kbd("Ctrl+Shift+C/V")} copy / paste, ${kbd("Ctrl+Shift+A")} selection → AI, ${kbd("Ctrl+Shift+I")} AI panel</li>
        <li>${kbd("Ctrl+Shift+K")} local AI: a command from a description in words</li>
        <li>${kbd("Ctrl+Shift+P")} command palette — search across OpsDeck (clusters, hosts, notes, snippets, command history)</li>
      </ul>
      <p>Hotkeys work on any keyboard layout.</p>
      <h4>Kubernetes in the terminal</h4>
      <p>In OpsDeck tabs <code>kubectl</code> sees only OpsDeck's clusters (not your shared ~/.kube/config).</p>`,
  },
  k8s: {
    title: "Kubernetes",
    html: `
      <h4>How it works</h4>
      <p>OpsDeck keeps its own kubeconfig copies (a file per context) and doesn't touch your ~/.kube/config. Tables update live (watch).</p>
      <h4>What's where</h4>
      <ul>
        <li><b>＋</b> top left — add a cluster: tick contexts from ~/.kube/config, paste YAML or just drop a file into the window.</li>
        <li>Hover a context: <b>🔒</b> read-only (blocks apply/delete/scale/restart/exec), <b>🙈</b> hide, <b>🗑</b> delete the copy.</li>
        <li>On the left — resource types; at the bottom “Custom resources” — all the cluster's CRDs (with a filter).</li>
        <li>At the top: namespace, filter, <b>live</b> — live updates, <b>⎈ Terminal</b> — a shell with kubectl/helm/k9s in this context.</li>
        <li>Click a row — a panel at the bottom: <b>Logs</b> (for a deployment — from all pods at once, a colour per pod), <b>Details</b> (links to the owner, node, volumes are clickable), <b>YAML</b> (edit and “Apply”).</li>
        <li>Buttons on the right of the panel: Shell, Port-forward, Scale, Restart, Delete; for Helm — Rollback/Uninstall, for Argo CD — Refresh/Sync.</li>
        <li>Pods and nodes have CPU/RAM columns (needs metrics-server).</li>
        <li>A pod stuck in <b>Terminating</b> (its node is offline): Delete explains why and offers <b>Force delete</b>.</li>
      </ul>
      <h4>Tips</h4>
      <ul><li>Put 🔒 on prod — the backend itself blocks changes, a stray click breaks nothing.</li>
      <li>Deleting always asks you to type the object's name.</li></ul>`,
  },
  web: {
    title: "Web panels",
    html: `
      <h4>How it works</h4>
      <p>Grafana, ArgoCD, GitLab and any sites open as tabs right here, with automatic login. Passwords are in the system keyring or KeePass.</p>
      <h4>What's where</h4>
      <ul>
        <li><b>＋ Add</b> — a new connector: type, URL, login method (login/password, token, KeePass entry).</li>
        <li><b>Open</b> — a tab next to “☰ Panels”; <b>⧉</b> — in a separate window.</li>
        <li><b>Groups</b>: the “Group” field in a panel card — panels with the same group are gathered into a collapsible row, like a Row in a Grafana dashboard. <b>✎</b> — edit, <b>🗑</b> — delete.</li>
        <li>On the right of a tab: <b>← → ↻ ⌂</b> — navigation, <b>⧉</b> — move to a window.</li>
        <li><b>− auto 90% +</b> — page zoom. “Auto” fits the site to the panel width, so it looks right on a laptop and on a big monitor alike. A manual zoom is remembered per panel and per screen; click the percentage — back to “auto”. Inside a panel and in a separate window ${kbd("Ctrl +")} / ${kbd("Ctrl −")} / ${kbd("Ctrl 0")} work.</li>
        <li>Grafana with login/password or a token, <b>Alertmanager</b> and <b>AI / analyzer</b> are also sources for the “Alerts” section. Their dialog has a step-by-step guide and a <b>Save and check</b> button.</li>
      </ul>
      <h4>Caveats</h4>
      <ul><li>A panel's page lies on top of the interface: while focus is inside it, OpsDeck hotkeys don't work — click the interface.</li>
      <li>SSO login (Keycloak, Google) is done manually once, then the session is kept. GitLab 2FA — manually too.</li></ul>`,
  },
  alerts: {
    title: "Alerts",
    html: `
      <h4>How it works</h4>
      <p>OpsDeck polls the sources itself (once a minute, configurable in ⚙) — nothing comes into this computer from outside, so IP and NAT don't matter. Sources are added in “Web panels” (◎):</p>
      <ul>
        <li><b>Grafana</b> — Grafana Alerting alerts (login/password, a service account token with the Viewer role, or KeePass);</li>
        <li><b>Alertmanager</b> — Prometheus Alertmanager;</li>
        <li><b>Zabbix</b> — Zabbix 6.0+ problems over the API: an API token (Users → API tokens) or a login/password;</li>
        <li><b>AI / analyzer</b> — findings of your log/alert analyzer: a local one posts them to 127.0.0.1 with its token, a remote one serves a JSON feed at a URL.</li>
      </ul>
      <h4>Connecting Grafana — step by step</h4>
      <ol>
        <li>Nothing to configure in Grafana: no contact point, no webhook. Only read access is needed.</li>
        <li>In Grafana: <b>Administration → Users and access → Service accounts → Add service account</b>, name <code>opsdeck</code>, role <b>Viewer</b> → Create.</li>
        <li>On the account page: <b>Add service account token → Generate</b>, copy the token <code>glsa_…</code> (shown once).</li>
        <li>Here: the <b>＋ Grafana</b> button (or ◎ → ＋ Add → type Grafana), the URL as in the browser, Authorization = <b>token</b>, paste → <b>Save and check</b>. You'll see “✓ Works: N active alerts” or the reason of the error.</li>
      </ol>
      <p>A token only collects alerts. For Grafana to also open as a tab with auto-login, choose “login/password” or a KeePass entry.</p>
      <h4>If there is an error</h4>
      <ul>
        <li><b>401</b> — wrong token/password; <b>403</b> — not enough rights (Viewer is needed);</li>
        <li><b>404</b> — Grafana Alerting is not enabled in Grafana, or the alerts live in Prometheus Alertmanager — then add an Alertmanager connector;</li>
        <li><b>no connection</b> — the URL is not reachable from this computer (VPN?).</li>
      </ul>
      <h4>What's where</h4>
      <ul>
        <li>The number on the bell on the left — firing alerts (without seen, silenced and hidden ones).</li>
        <li>Sections by age: <b>🆕 New</b> (24 hours), <b>This week</b>, <b>Firing for a long time</b> (over 7 days — usually noise), <b>Seen and silenced</b>. Sections collapse, the state is remembered.</li>
        <li>Identical alerts (one rule from one source) are gathered into one card with a <b>×N</b> counter; “instances” show how they differ (instance, pod…).</li>
        <li>Filters at the top: severity (click — only it, click again — all), source, search by name/labels/text.</li>
        <li><b>🔕 Hide these</b> — remove a noisy alert (by name and source) from the list, the counter and notifications. Undo: ⚙ → “Hidden alerts”.</li>
        <li>Card buttons: <b>Panel / Dashboard / Rule / Silence</b> open in the built-in Grafana tab; <b>⇢ AI</b> — analyse the alert in Claude; <b>✓ Seen</b> — remove from the counter; AI findings have <b>Close</b>.</li>
        <li><b>↻ Poll</b> — now; source errors are shown as a red line at the top.</li>
        <li>An alert that disappears from its source becomes resolved and goes to history.</li>
      </ul>`,
  },
  net: {
    title: "Network & DNS",
    html: `
      <h4>How it works</h4>
      <p>System tools are run and their output streams line by line. Dangerous arguments are cut off — an option can't be passed in the address field.</p>
      <h4>What's where</h4>
      <ul><li><b>Tools</b> tab: ping, mtr (report), traceroute, dig, nslookup, a single TCP port check.</li>
      <li><b>Ports</b> tab: a host port scan (a list and ranges, e.g. <code>22,80,8000-8100</code>, or presets) — open / closed / filtered and what answers (service banner, Server header, TLS); below — which ports this machine listens on and which process holds them.</li>
      <li>For DNS you can set the record type and the server (e.g. 8.8.8.8), for ping/mtr — the packet count.</li>
      <li><b>Stop</b> interrupts a long command.</li></ul>`,
  },
  monitor: {
    title: "Host monitoring",
    html: `
      <h4>What it is</h4>
      <p>A board of SSH host cards: CPU, load average, memory, disk and uptime. The card colour follows the worst value: yellow from 75%, red from 90%.</p>
      <h4>How to turn it on</h4>
      <ul><li>The module is turned on with a checkbox in the ⊞ menu at the bottom of the left column.</li>
      <li><b>＋ Hosts</b> — choose profiles from the SSH section and hosts from ~/.ssh/config; the choice is remembered. Host groups become sections of the board.</li>
      <li>“Refresh” — how often to poll (or by hand with ⟳). While the section is not open, hosts are not polled.</li></ul>
      <h4>How metrics are collected</h4>
      <p>Over ssh without a password: a key login (ssh-agent, IdentityFile) or a session already open in OpsDeck is needed. The connection is kept for 2 minutes and reused, so the next poll is cheap. /proc and df are read — Linux only. If a host has never been connected to, accept its key: connect once from the terminal.</p>`,
  },
  ssh: {
    title: "SSH",
    html: `
      <h4>How it works</h4>
      <p>“Connect” opens a terminal tab with ssh. Hosts from ~/.ssh/config connect by alias with all their settings (keys, ProxyJump).</p>
      <h4>What's where</h4>
      <ul><li><b>＋ Host</b> — your own profile: address, port, user, key (-i), jump host (-J), login method.</li>
      <li>A password from KeePass/keyring goes to the clipboard for 30 seconds — paste with ${kbd("Ctrl+Shift+V")} when ssh asks.</li>
      <li><b>Groups</b> — collapsible blocks. For your own profile the group is set in ✎, for a host from ~/.ssh/config — with the 📁 button (OpsDeck keeps it to itself and doesn't change the ssh config) or with a <code># group: prod</code> comment on the line above <code>Host</code>. ✎ in a group header renames the whole group.</li>
      <li><b>⧉</b> on a host from ~/.ssh/config — save as a profile to bind a KeePass password.</li>
      <li>All hosts are in the palette ${kbd("Ctrl+Shift+P")} → “SSH: …”.</li></ul>`,
  },
  code: {
    title: "IDE: code & git",
    html: `
      <h4>How it works</h4>
      <p>A built-in code editor with syntax highlighting (TypeScript/JavaScript, Python, Go, Rust, YAML, JSON, Terraform/HCL, SQL, Shell, Dockerfile, TOML, Markdown, HTML/CSS…), a project tree and a git panel.</p>
      <h4>What's where</h4>
      <ul>
        <li><b>📂</b> — choose the project folder in the system dialog (the whole project opens as a tree on the left), <b>⌁</b> — take the folder the terminal is in, <b>＋</b> — a new file (a path ending in / — a folder). Recent projects are in the list under the header.</li>
        <li>The tree is coloured by git changes: yellow — changed, green — new, red — deleted.</li>
        <li>${kbd("Ctrl+S")} — save. If the file was changed outside after it was opened, OpsDeck asks whether to overwrite it.</li>
        <li>${kbd("Ctrl+F")} — find and replace, ${kbd("Ctrl+/")} — comment out, ${kbd("Tab")} / ${kbd("Shift+Tab")} — indent.</li>
        <li><b>▭ console</b> at the bottom (${kbd("Ctrl+`")}) — a terminal right in the project folder: ↻ restart, ⧉ open this folder in a terminal tab. When the project changes, the console runs <code>cd</code> itself.</li>
        <li><b>Panel sizes</b> — drag the borders between the tree, the editor, the console and the git panel; double-click a border — back to the default size. Sizes are remembered.</li>
        <li><b>⎇ git</b> at the bottom right — the git panel: changed files (click — diff, double-click — open the file), the commit box (<b>Commit all</b> = <code>git add -A</code> + commit, ${kbd("Ctrl+Enter")}) and the commit graph of all branches (click — the whole commit).</li>
        <li><b>Branches</b> — the button with the branch name at the top of the git panel: click a branch — switch (a remote one becomes a local tracking branch), <b>＋ New branch</b> — from the current one, on hover <b>⤵</b> — merge into the current one, <b>×</b> — delete (OpsDeck asks again for an unmerged one). <b>⟳</b> fetch, <b>↓</b> pull (fast-forward only), <b>↑</b> push (a new branch goes with <code>-u origin</code>). Open files are re-read after switching; if they have unsaved edits, OpsDeck warns you.</li>
        <li>In the terminal's “Files” panel and with ${kbd("Ctrl")}+click on a path in the output, files open here if “OpsDeck IDE” is chosen there.</li>
      </ul>
      <h4>Checks and formatting</h4>
      <ul>
        <li><b>YAML</b> and <b>JSON</b> — syntax errors are underlined right away, with a marker in the left gutter; hover it — the error text.</li>
        <li><b>Terraform</b> (.tf, .tfvars, .hcl) — checked with <code>terraform fmt</code> (or <code>tofu</code>), errors are shown on their lines. On save the file is formatted like <code>terraform fmt</code>; ${kbd("Ctrl+Shift+F")} or the <b>fmt</b> button — format now. Without terraform in PATH only brackets and quotes are checked.</li>
      </ul>`,
  },
  db: {
    title: "Databases",
    html: `
      <h4>How it works</h4>
      <p>Connections to PostgreSQL, MySQL/MariaDB, ClickHouse, Redis and MongoDB: address, port, login. The password is kept in the system keyring or taken from a KeePass entry. On the left — the structure: databases → schemas → tables → columns and indexes (for Redis — db and keys, for MongoDB — collections, fields and indexes). On the right — the query editor and the result.</p>
      <h4>What's where</h4>
      <ul>
        <li><b>＋</b> — a new connection. <b>Save and check</b> shows the server version or the error right away.</li>
        <li>Hover a connection: <b>↻</b> — reload the structure, <b>✎</b> — edit, <b>×</b> — delete.</li>
        <li>A click on a database or table chooses the database the query runs in (the <b>“in”</b> field at the top). A double-click on a table, collection or key shows the first rows right away.</li>
        <li>${kbd("Ctrl+Enter")} — run. If something is selected, only the selection runs. The first 1000 rows are shown.</li>
        <li><b>History</b> — the last 50 queries of this connection; the query draft is saved automatically.</li>
        <li>Double-click a cell — copy its value; <b>CSV</b> / <b>JSON</b> — copy the whole result. MongoDB has a <b>JSON</b> view with whole documents.</li>
        <li>The bar between the editor and the result changes the editor height.</li>
      </ul>
      <h4>Syntax</h4>
      <ul>
        <li><b>SQL</b> (PostgreSQL, MySQL, ClickHouse) — as usual, several queries with <code>;</code> are allowed — the result of the last one is shown.</li>
        <li><b>Redis</b> — commands one per line, like in redis-cli: <code>HGETALL user:1</code>, <code>SCAN 0 MATCH sess:* COUNT 100</code>.</li>
        <li><b>MongoDB</b> — like in mongosh: <code>db.users.find({ age: { $gt: 30 } }).sort({ name: 1 }).limit(20)</code>, <code>aggregate([...])</code>, <code>countDocuments</code>, <code>distinct</code>, <code>insertOne</code>, <code>updateMany</code>…, a command <code>{ serverStatus: 1 }</code>, <code>show dbs</code>, <code>show collections</code>.</li>
      </ul>
      <h4>Read-only</h4>
      <p>A checkbox in the connection, for prod databases. PostgreSQL and ClickHouse block writes on the server side; for MySQL, Redis and MongoDB only read queries and commands are executed. The connection shows 🔒, the editor — “read-only”.</p>`,
  },
  notes: {
    title: "Notes",
    html: `
      <h4>How it works</h4>
      <p>Notes are plain .md files in a vault folder. There can be several vaults (e.g. “Work” and “Personal”), any of them can be opened in Obsidian too. Files are edited in place.</p>
      <h4>Vaults</h4>
      <ul>
        <li>The button with the vault name at the top left: switch to another one, <b>＋ Create vault</b> (a name and a folder; the first note with tips is created inside), <b>📂 Open a folder as a vault</b> — an Obsidian vault or any folder with .md.</li>
        <li>Obsidian vaults found on disk are marked “found” — a click connects one. <b>×</b> removes a vault from the list, the folder stays on disk.</li>
      </ul>
      <h4>What's where</h4>
      <ul><li>On the left — recent notes, <b>tags</b> (click — notes with that tag) and the folder tree; search at the top; <b>⊟</b> collapse all folders.</li>
      <li><b>📅</b> today's note, <b>＋</b> new note. <b>＋</b> on a folder row — a new note right in it.</li>
      <li><b>⋯</b> on a row (or right-click): new note here, rename, <b>delete</b>. Deleted items move to the vault's trash (the <code>.trash</code> folder, like in Obsidian) — you can restore them from there.</li>
      <li><b>Drag and drop</b>: drag a note or a folder into another folder or to the root. Hold over a closed folder — it opens.</li>
      <li><b>Editor / Preview</b> (${kbd("Ctrl+E")}), <b>Save</b> (${kbd("Ctrl+S")}), [[…]] links are clickable.</li>
      <li><b>@ Claude</b> — insert a link to the note (or the selected lines) into the Claude Code prompt; <b>Obsidian ↗</b> — open in Obsidian.</li></ul>
      <h4>Tags</h4>
      <p>Above the note there is a tag bar: type a tag into <b>＋ tag</b> and press ${kbd("Enter")} — existing tags are suggested. These tags are stored at the top of the note (<code>tags: [...]</code>, like in Obsidian), <b>×</b> removes one. Tags written right in the text (<code>#idea</code>) are shown too — with a dashed border.</p>
      <h4>Tasks</h4>
      <p><b>＋ Task</b> — a form: what to do, due date (Today/Tomorrow/In a week buttons), reminder time, priority, tags. A line like <code>- [ ] Renew the certificate #infra 📅 2026-10-05 ⏰ 10:00</code> (the Obsidian Tasks plugin format) is inserted into the note: in the editor — under the cursor, in the preview — at the end. In the preview the checkboxes are clickable. All tasks from all notes are in the <b>Tasks</b> section.</p>`,
  },
  tasks: {
    title: "Tasks & reminders",
    html: `
      <h4>How it works</h4>
      <p>Tasks are <code>- [ ] …</code> lines in the notes of the current vault. Here they are gathered by due date: <b>Overdue, Today, Tomorrow, This week, Later, No due date</b> and those done in the last 14 days. Any change here changes the line in the note itself, so tasks are visible in Obsidian too.</p>
      <h4>What's where</h4>
      <ul>
        <li><b>＋ Task</b> — a new task: in the “Задачи.md” note by default, another one can be chosen.</li>
        <li>The checkbox — done (✅ date is added), unticking returns the task to work.</li>
        <li>Click the due date — change it; on hover <b>→ tomorrow</b> and <b>✎</b> (text, due date, time, priority, tags; or double-click the text). On the right — the note name: open it at this line.</li>
        <li>Tags at the top and in task text are clickable — only tasks with that tag are shown; search — by text, tag and note.</li>
        <li><b>📅 Calendar</b> — a month with each day's tasks; click a day — its list below and <b>＋ task for this day</b>.</li>
        <li>The number on the icon on the left — overdue and today's tasks.</li>
      </ul>
      <h4>Reminders</h4>
      <ul>
        <li>If a task has a due date and a time (⏰), at that time a system notification and a card in the corner of OpsDeck pop up: <b>✓ Done</b>, <b>Snooze</b> for 10 min / 30 min / an hour / 3 hours, <b>Open</b> the note.</li>
        <li>Every morning after 9:00 — a summary: what's due today and how many are overdue.</li>
        <li>Reminders work while OpsDeck is running. If it was closed, a missed reminder (up to 12 hours old) shows at startup.</li>
      </ul>`,
  },
  vault: {
    title: "KeePass",
    html: `
      <h4>How it works</h4>
      <p>The .kdbx database is opened read-only, decrypted only in memory. The password is entered once: the database stays open until OpsDeck closes (in ⚙ you can switch to auto-lock after idle instead). Make edits in KeePassXC — OpsDeck notices the file changed and re-reads it within a couple of seconds, without asking for the password again. If the master password changed, re-reading fails — you'll get a message; lock and open the database again.</p>
      <h4>What's where</h4>
      <ul><li>👤 / 🔑 in a row — copy the login / password; the password is wiped from the clipboard after 30 seconds.</li>
      <li>Click a row — details: 👁 show the password for 10 seconds, the entry's notes.</li>
      <li>KeePass entries can be bound to web panels, SSH hosts and MikroTik routers — then passwords are taken from here.</li>
      <li>While the database is open, passwords are in the palette ${kbd("Ctrl+Shift+P")} → “Password: …”.</li></ul>`,
  },
  winbox: {
    title: "MikroTik",
    html: `
      <h4>What's where</h4>
      <ul><li><b>＋ Device</b> — address, WinBox/SSH ports, credentials (from KeePass, the keyring or no password).</li>
      <li><b>WinBox</b> connects to the router right away; <b>SSH</b> — a terminal tab, the password in the clipboard for 30 s; <b>ping</b> — a tab with ping.</li>
      <li><b>Import from WinBox</b> brings over the routers saved in WinBox's address list (Addresses.cdb): address, port, login, group, the note as the name and, if ticked, passwords — into the OS keyring. The list is shown before anything is added; addresses already here are skipped. If WinBox has a master password, remove it for the import.</li>
      <li>The WinBox path — in ⚙ Settings.</li></ul>
      <h4>Caveat</h4>
      <p>WinBox accepts the password only as a command-line argument, so while it is open the password is visible in your user's process list.</p>`,
  },
  settings: {
    title: "Settings",
    html: `
      <ul><li><b>Language</b>: “System” follows the system locale; Russian or English can be chosen explicitly. The interface reloads when it changes.</li>
      <li><b>Modules</b>: the ⊞ button at the bottom of the left column turns sections on and off with checkboxes. A fresh install starts with Terminal, Kubernetes, SSH, KeePass and Notes. If another section needs one (e.g. SSH opens a terminal tab), it is turned on automatically.</li>
      <li><b>Icon order</b> in the left column is changed by dragging with the mouse and is remembered (⚙ always stays at the bottom).</li>
      <li><b>Terminal</b>: input and output highlighting, inline suggestions, font size and family. Enter the name of an installed monospace font; choose MesloLGS NF or a Nerd Font for Powerlevel10k icons. The choice applies immediately to all terminals and is remembered. An empty field restores the default font.</li>
      <li><b>Colour scheme</b> of the terminal: OpsDeck, Campbell, One Half Dark, Solarized Dark, Dracula or your own — <i>Import JSON…</i> takes Windows Terminal's settings.json, a list of schemes or one scheme. Applies to all terminals at once.</li>
      <li><b>Windows</b> (shown on Windows only): the shell for new tabs — PowerShell 5.1 or 7, Git Bash, cmd, a WSL distribution — and importing schemes straight from the installed Windows Terminal. The <b>WSL</b> button next to ＋ in the terminal opens a tab of the chosen distribution; it gets TERM, COLORTERM and KUBECONFIG (paths as /mnt/c/…), and the AI command in a WSL tab suggests Linux commands.</li>
      <li><b>KeePass</b>: “Keep the database open until OpsDeck closes” (on by default) or auto-lock after N minutes idle.</li>
      <li>Paths to the KeePass database, the notes folder and WinBox are filled in automatically if found in the home folder (candidates — in the field's dropdown).</li>
      <li><b>Kubernetes</b>: by default OpsDeck works only with its own kubeconfig copies; the checkbox also shows the shared ~/.kube/config.</li>
      <li><b>Snippets</b>: commands with {{name}} or {{name:value}} parameters — run via the palette ${kbd("Ctrl+Shift+P")}, the command is pasted into the terminal, you press Enter.</li>
      <li><b>Updates</b>: OpsDeck checks GitHub Releases (at startup, if enabled, or with the button). When there is a new version, ⚙ gets a ↑; “Update and restart” downloads it, checks the signature and installs it. On Linux the system asks for a password for .deb/.rpm, an AppImage updates without one. If a new version misbehaves — “Other versions” → <b>Roll back</b> to any previous one. If a version was withdrawn because of a critical bug, OpsDeck offers going back to the stable one itself.</li>
      <li><b>Local AI</b>: choose a model: the light Qwen2.5-Coder 1.5B (≈1.1 GB, default), Qwen3.5 4B and 9B or Qwen3.6 35B-A3B for powerful PCs (★ marks what fits your RAM), or your own .gguf file. “Install” downloads the llama.cpp engine and the model with a checksum check into OpsDeck's data folder — the app installer doesn't grow. Downloaded models can be removed one by one. <b>Acceleration</b> “GPU (Vulkan)” on Linux and Windows works with NVIDIA, AMD and Intel (a driver with Vulkan is needed); on a Mac the GPU is used automatically — big models answer several times faster with it. The built-in engine works offline, requests go nowhere. <b>External AI server</b>: if you already run Ollama, vLLM, LM Studio or another server with an OpenAI-compatible API, set its address, model and, if needed, an API key (kept in the system password store) — requests go there instead of the built-in engine. Note: commands from your notes, recent commands and the current folder are sent along with the request.</li>
      <li><b>Log</b>: errors, UI freezes (with what was running at that moment), crashes and slow operations are written to a file; “Show errors and freezes” — a quick look at what happened, “Open folder” — attach the file to a bug report.</li>
      <li>All settings are in ~/.config/opsdeck/, passwords — in the system keyring.</li></ul>`,
  },
};
