/** English version of the built-in guides ("!" buttons); same ids as in help.ts. */
const kbd = (k: string) => `<kbd>${k}</kbd>`;

export const HELP_EN: Record<string, { title: string; html: string }> = {
  terminal: {
    title: "Terminal & AI",
    html: `
      <h4>How it works</h4>
      <p>Every tab is a real shell (bash/zsh) with OpsDeck integration: each command becomes a <b>block</b> with its exit code and duration. On the right is the AI panel: Claude Code (or Codex/Gemini/Aider/OpenCode) runs there in its own terminal, or <b>OpsDeck AI (local)</b> — a chat with the built-in model (or your AI server from ⚙ Settings). The answer is printed as it is generated; commands from it go into the active tab by «▸ To terminal» — without Enter, nothing runs by itself.</p>
      <h4>What's where</h4>
      <ul>
        <li><b>＋</b> — new tab (opens in the same folder), <b>◫ / ⊟</b> — split right / down. When there are more tabs than fit, scroll the tab bar with the mouse wheel.</li>
        <li>Hover a command to get the block toolbar: copy the command or its output, <b>★</b> save as a snippet, <b>⇢ AI</b> send the command with its output to AI.</li>
        <li>When a command fails, an <b>“ask AI”</b> bar appears at the bottom.</li>
        <li><b>⇢ to AI</b> — send the selected text; <b>AI ▸</b> — show/hide the AI panel, the model is chosen there.</li>
        <li><b>◆ Claude IDE</b> in the tab bar — Claude Code is connected to OpsDeck and sees selections in notes.</li>
        <li>Coloured marks on the scrollbar are commands (red — failed).</li>
        <li><b>⏺</b> — record the active pane to a text file (on/off); a red dot on the tab while recording. Files go to Documents/OpsDeck/sessions, <b>📂</b> next to ⏺ opens that folder. Passwords you type are not recorded — the terminal doesn't display them.</li>
        <li><b>↗ Separate window</b> — move the terminal into a second window: on a second monitor it stays in front of you and you don't have to switch sections. The tabs and panes stay in the main window too, and the new window gets a terminal of its own (their sessions are separate). Almost any section can be moved out this way: right-click its icon on the left, or the command palette (${kbd("Ctrl+Shift+P")}) → “Open in a separate window”. The window's size and place are remembered; closing the main window closes the detached ones with it.</li>
        <li><b>A− 13 A+</b> — font size in all terminals (click the number — back to 13). Also ${kbd("Ctrl+=")} / ${kbd("Ctrl+-")} / ${kbd("Ctrl+0")} or ${kbd("Ctrl")}+mouse wheel over the terminal. The size is remembered.</li>
        <li><b>The bottom bar</b> — resources of the machine: this one, or the remote one when the active tab runs an SSH session (Linux hosts; metrics go over the same SSH connection, no second login).</li>
        <li><b>Highlighting</b>: while typing, the command is green if it exists and red if not (aliases and functions from your .bashrc/.zshrc count); flags, strings, $VARIABLES, | && ; and comments get their own colours. In the output: ERROR/WARN, pod states (Running, CrashLoopBackOff…), IPs, links and time. Turn off in ⚙ → Terminal or via the palette.</li>
        <li><b>🌐 Folder on the web</b> — serve the folder the active pane's shell is in over http: <code>python3 -m http.server</code> is sent into the session, bound to the host's 127.0.0.1 (never exposed to the network), an <code>ssh -L</code> tunnel is opened to it and the link opens in the browser. Handy for grabbing files off a server without sftp. ${kbd("Ctrl+C")} in the terminal stops it, and the tunnel closes with the tab. If you went further to another host from inside the session, the tunnel leads to the first one and the share will not answer — OpsDeck notices that and offers to serve the folder on all of the host's addresses (visible to anyone who can reach it over the network).</li>
        <li><b>📁 Files</b> (${kbd("Ctrl+Shift+B")}) — tree of the folder the shell is in (follows <code>cd</code>; ⌖ — stop following, double-click a folder — make it the root). Click a file — open it in the chosen editor (the built-in <b>OpsDeck IDE</b> by default); <b>Open in IDE</b> — the whole project (the git repository root). On a row: ↗ — in the IDE, ⎘ — paste the path into the terminal, ⤷ — cd. Colours show git status: yellow changed, green new, red deleted. External editors are detected (VS Code, Cursor, Zed, Sublime, JetBrains…; vim/nvim/helix open in a terminal tab), or “Custom command…”.</li>
        <li><b>Inline suggestion</b>: the rest of the command in grey, from this session, bash/zsh history and code blocks in notes. ${kbd("→")} or ${kbd("End")} — accept it all, ${kbd("Ctrl+→")} — one word. Turn off in ⚙ → Terminal.</li>
        <li><b>Several AIs side by side.</b> Picking an agent at the top of the AI panel no longer restarts it: one already open just gets the focus, a new one is added next to it (up to three). Each keeps its own conversation and its own ⟳ and ×. A selection or logs go to the one in focus.</li>
        <li><b>✦ AI</b> (${kbd("Ctrl+Shift+K")}) — <b>local AI</b>: describe in words what to do (“restart the api deployment in stage”) and get a command based on your notes and history. <b>Paste</b> (${kbd("Enter")}) puts it on the line without running, <b>Run</b> (${kbd("Ctrl+Enter")}) runs it. The model (Qwen2.5-Coder 1.5B by default) is chosen and installed in ⚙ → Local AI and runs only on this computer.</li>
        <li><b>AI knowledge base</b> — built-in cheat sheets for kubectl, helm, docker, systemd, terraform, git, ssh, jq, networking, disks, nginx, PostgreSQL, MySQL, ClickHouse, Kafka, Redis, Vault, PromQL, ansible, certificates and Yandex Cloud: when a request looks like one of the topics, proven commands go into the model's prompt, so the flags are real rather than invented. Your own commands go into <code>knowledge.md</code> next to the settings (⚙ → Local AI → “Open folder”), and they come first.</li>
        <li>${kbd("Ctrl")}+click a path in the output (e.g. <code>src/main.rs:42</code> from a compiler error) — open the file in the editor at that line.</li>
      </ul>
      <h4>Hotkeys</h4>
      <ul>
        <li>${kbd("Ctrl+Shift+T")} new tab, ${kbd("Ctrl+Shift+W")} close pane/tab</li>
        <li>${kbd("Alt+1")}…${kbd("Alt+9")} go to a tab by number (${kbd("Alt+9")} — the last one), ${kbd("Alt+←/→")} or ${kbd("Ctrl+Tab")} / ${kbd("Ctrl+Shift+Tab")} — previous / next tab</li>
        <li>${kbd("Ctrl+Shift+D")} / ${kbd("Ctrl+Shift+E")} split right / down (a WSL pane — into the same distribution), ${kbd("Ctrl+Shift+←/→")} between panes. Up to 6 panes in a tab: two sit side by side or stacked, three and more form a grid; with several, each has its own header with the host's name (⇱ — move to a tab of its own, × — close)</li>
        <li><b>Different hosts in one tab</b>: the ▤ button next to the split buttons (<i>A new pane with an SSH host</i>) — pick a host from the SSH profiles and <code>~/.ssh/config</code>, it opens as a new pane. Or do it the Termius way: open the target tab, take another tab with the mouse and drag it onto the terminal area — an edge (left, right, top, bottom) splits the window, the middle adds to the grid. The sessions keep running, nothing reconnects.</li>
        <li>${kbd("Ctrl+Shift+↑/↓")} to the previous / next command</li>
        <li>${kbd("Ctrl+=")} / ${kbd("Ctrl+-")} / ${kbd("Ctrl+0")} font size</li>
        <li>${kbd("Ctrl+Shift+C/V")} copy / paste, ${kbd("Ctrl+Shift+A")} selection → AI, ${kbd("Ctrl+Shift+I")} AI panel</li>
        <li>${kbd("Ctrl+Shift+R")} reconnect: an SSH/kubectl exec tab whose session dropped stays open — «⟳ Reconnect» (or ${kbd("Enter")}); a failed <code>ssh</code> typed in a shell — «⟳ Retry»</li>
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
        <li><b>Diagnostics</b> (at the top of the resource list), computed from what your kubeconfig can read — nothing is installed in the cluster:
          <b>Problems</b> — what is broken now: CrashLoopBackOff, OOMKilled, image pull errors, pods that cannot be scheduled (with the reason), unfinished rollouts, failed Jobs, pods stuck in Terminating (which finalizers hold them), references to missing ConfigMaps/Secrets/PVCs, services without pods or ready endpoints, Ingresses to a missing service or port. Pods of one app with the same trouble are one row (×N).
          <b>Checks</b> — best practices of the templates: privileged, hostPID/hostNetwork, the docker/containerd socket, dangerous capabilities, the latest tag, missing probes, a single replica, no PodDisruptionBudget, no requests/limits — each with “How to fix”. A row opens the explanation, “Open the object” and “⇢ AI”. System namespaces (kube-system…) are hidden by a checkbox. Secret values never reach the diagnostics: the backend sends only names.</li>
        <li><b>Multiselect and row actions.</b> The ticks on the left select rows (the one in the header selects everything shown), “Delete the selected” removes them in one go, confirmed by their count. Hovering a row shows icons on the right: copy the name, logs, shell (pods and nodes), delete.</li>
        <li><b>Pods of an object.</b> A Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob and a node have a <b>Pods</b> tab: what belongs to that object, or what runs on that node, with status, restarts and CPU/RAM. A click opens the pod in the pods table.</li>
        <li><b>Shell on a node</b> (the Shell button on a node): runs <code>kubectl debug node/…</code> — a temporary pod on the node with its filesystem at <code>/host</code>. Needs Kubernetes 1.25+ and the right to create pods; the image is asked for and remembered.</li>
        <li><b>Logs to a file</b> — the “To a file” button in the log panel saves the shown lines (filter included) to a text file.</li>
        <li><b>Event history</b> (Cluster → Event history): Kubernetes keeps events for about an hour, so by morning “what fell over at night” is gone. “Record this cluster's events” — while OpsDeck runs it watches events of all namespaces and keeps them for a week; repeats fold into one row (×N). At the top — what fell over most in 24 h (click to filter); a row opens its message and “⇢ AI”.</li>
        <li><b>Kubeconfig folders</b> (⚙ → Kubernetes, like in Freelens): every kubeconfig in the folder (and subfolders two levels deep) is listed as clusters marked “folder” and read in place — a new file shows up after ⟳ or the next time the section opens.</li>
        <li>The <b>label filter</b> next to the plain one works like <code>kubectl -l</code>: <code>app=api</code>, <code>tier!=db</code>, <code>env in (prod,stage)</code>, <code>!canary</code>; terms separated by commas. <b>Nodes</b>: CPU and RAM refresh every 5 s — a usage bar and a chart of the last samples (metrics-server needed).</li>
        <li><b>＋</b> top left — add a cluster: tick contexts from ~/.kube/config, paste YAML or just drop a file into the window.</li>
        <li>Hover a context: <b>🔒</b> read-only (blocks apply/delete/scale/restart/exec), <b>🙈</b> hide, <b>🗑</b> delete the copy.</li>
        <li>On the left — resource types; at the bottom “Custom resources” — all the cluster's CRDs (with a filter).</li>
        <li>At the top: namespace, filter, <b>live</b> — live updates, <b>⎈ Terminal</b> — a shell with kubectl/helm/k9s in this context.</li>
        <li>Click a row — a panel at the bottom: <b>Logs</b> (for a deployment — from all pods at once, a colour per pod), <b>Details</b> (links to the owner, node, volumes are clickable), <b>YAML</b> (edit and “Apply”).</li>
        <li>Buttons on the right of the panel: Shell, Port-forward, Scale, Restart, Delete; for Helm — Rollback/Uninstall, for Argo CD — Refresh/Sync.</li>
        <li>Pods and nodes have CPU/RAM columns (needs metrics-server).</li>
        <li>A pod stuck in <b>Terminating</b> (its node is offline): Delete explains why and offers <b>Force delete</b>.</li>
      
      <li><b>If the connection to the cluster drops</b>, the table dims and a line at the top gives the reason and the time the data is from: an old snapshot on screen is easy to mistake for your changes being rolled back. In YAML, after “Apply” the object is read back, and if that fails it says so instead of silently showing the old text.</li>
      <li><b>Sorting</b> — click a column header. For load (CPU, RAM) and age the first click puts the largest on top, and the arrow in the header shows the direction. On nodes these columns sort by the share of capacity rather than by gigabytes: a node at 100% matters more than one with more bytes used but room to spare.</li>
      <li><b>Several namespaces</b> — the ones you pick become chips next to the list: click to switch, × to remove. They are remembered per context, eight at a time.</li>
      <li><b>From the keyboard</b>: ${kbd("↑")} / ${kbd("↓")} — row, ${kbd("Enter")} — details, ${kbd("Space")} — mark for bulk actions, ${kbd("Alt+↑")} / ${kbd("Alt+↓")} — previous and next kind on the left. ${kbd("Ctrl+Shift+1")}…${kbd("Ctrl+Shift+9")} switch modules (9 is the last in the column).</li>
      <li><b>A chart above the logs</b> — how many lines were in each slice of time, errors in red, warnings in yellow. A click on a bar keeps only its lines, a second click clears it. The “chart” tick hides it altogether.</li></ul>
      <h4>Tips</h4>
      <ul><li>Put 🔒 on prod — the backend itself blocks changes, a stray click breaks nothing.</li>
      <li>Deleting always asks you to type the object's name.</li></ul>`,
  },
  web: {
    title: "Web panels",
    html: `
      <h4>How it works</h4>
      <p>Grafana, ArgoCD, GitLab and any sites open as tabs right here, with automatic login. Passwords are in the system keyring, KeePass or Passbolt.</p>
      <h4>What's where</h4>
      <ul>
        <li><b>＋ Add</b> — a new connector: type, URL, login method (login/password, token, KeePass or Passbolt entry).</li>
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
        <li><b>Zabbix</b> — Zabbix 6.0+ problems over the API, the same as on its Problems page (no disabled hosts and triggers, dependent ones or symptoms): an API token (Users → API tokens) or a login/password; if the web server in front of Zabbix asks for a password (HTTP Basic), fill in “Basic auth” in the connector (on 7.2+ behind Basic — login/password only, through the session of the web UI sign-in: a workaround);</li>
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
  yc: {
    title: "Yandex Cloud",
    html: `
      <h4>What it is</h4>
      <p>The cloud at a glance: instances, networks, security groups, public addresses, service accounts with their roles, and billing accounts. OpsDeck works through the cloud's own <code>yc</code> CLI and its profiles (<code>yc init</code>), so it <b>stores no tokens and no service-account keys</b> — everything comes from your own login.</p>
      <h4>What you need</h4>
      <ul><li>The module is enabled with a tick in the ⊞ menu at the bottom of the left column.</li>
      <li><code>yc</code> with <code>yc init</code> done. OpsDeck looks for it in PATH and where the installer puts it (<code>~/yandex-cloud/bin</code>, <code>~/.local/bin</code>, <code>/usr/local/bin</code>, <code>/snap/bin</code>): an app started from the menu does not read <code>~/.bashrc</code>, where the installer appends to PATH. If it lives somewhere else — the “Set the path to yc…” button under the header. With several profiles a list appears at the top — switching changes the CLI's own active profile.</li>
      <li>Pick the <b>cloud</b> and the <b>folder</b> at the top; everything below is shown for that folder.</li></ul>
      <h4>What's where</h4>
      <ul><li><b>Instances</b> — status, zone, configuration (platform, vCPU with core fraction, memory, “preemptible”) and addresses. Start, stop and restart ask for confirmation: these are real machines. <b>SSH</b> opens a terminal tab with the public address, or the internal one when there is none.</li>
      <li><b>Networks</b> — subnets grouped by network: zone, addresses, route table.</li>
      <li><b>Security groups</b> — rules in plain words: direction, protocol, ports and where from (addresses, “the same group”, another group, load-balancer health checks). A group with no rules lets nothing through.</li>
      <li><b>Addresses</b> — public addresses; a reserved address that is not in use is marked, as it is billed.</li>
      <li><b>Access</b> — the folder's service accounts and the roles granted on the folder.</li>
      <li><b>Billing</b> — billing accounts with their balance (visible if the profile has rights to them).</li></ul>`,
  },
  sftp: {
    title: "Files on hosts",
    html: `
      <h4>What it is</h4>
      <p>Two panes for exchanging files (#78): each one is either this machine or a host over SSH. Select files and press <b>→</b> or <b>←</b>. It works through the system <code>sftp</code> and <code>scp</code> — the same OpenSSH the terminal uses, so <code>~/.ssh/config</code>, ProxyJump and keys all apply.</p>
      <h4>How to use it</h4>
      <ul><li>The module is enabled with a tick in the ⊞ menu at the bottom of the left column.</li>
      <li>At the top of a pane — <b>where to look</b> (this machine, an SSH profile, a host from ~/.ssh/config); the path can be typed in, ↑ goes up, a double click on a folder enters it.</li>
      <li>A click on a column header changes the order: by name, size or modification date; folders always come first. For date and size the first click puts the newest and the largest on top.</li>
      <li>After a copy, what was transferred is selected in the receiving pane — you see at once what arrived.</li>
      <li>A click selects, ${kbd("Ctrl")}+click adds to the selection. At the bottom — create a folder, rename, delete (a folder goes with its contents).</li>
      <li><b>Host → host</b> goes through <code>scp -3</code>: OpsDeck runs both connections, so the hosts don't need to see each other and the keys stay with you. If a host has a non-standard port, its own key or a jump host, scp cannot split the options between the ends — download the files to yourself first, then upload them.</li></ul>
      <h4>Login</h4>
      <p>By key only (<code>BatchMode</code>): <code>sftp</code> reads a password from the terminal, and in batch mode there is nowhere to get it. If a host asks for a password — add a key (<code>ssh-copy-id</code>) or set one in the SSH profile. The host key must already be accepted: connect to it once from the terminal.</p>`,
  },
  monitor: {
    title: "Host monitoring",
    html: `
      <h4>What it is</h4>
      <p>A board of SSH host cards: CPU, load average, memory, disk and uptime. The card colour follows the worst value: yellow from 75%, red from 90%.</p>
      <h4>How to turn it on</h4>
      <ul><li>The module is turned on with a checkbox in the ⊞ menu at the bottom of the left column.</li>
      <li><b>＋ Hosts</b> — choose profiles from the SSH section and hosts from ~/.ssh/config; the choice is remembered. Host groups become sections of the board.</li>
      <li>“Refresh” — how often to poll (or by hand with ⟳). While the section is not open, hosts are not polled.</li>
      <li><b>The order of the cards</b> is set by dragging them. Until the board is rearranged, hosts in a group go by name (1, 2, 10); after the first drag the order is yours and is remembered.</li>
      <li><b>%</b> at the top switches RAM and disk between gigabytes and percentages.</li>
      <li>A group can be folded (▾): a summary by colour stays and its hosts are not polled. × on a card or a group takes it off the board — SSH profiles stay.</li></ul>
      <h4>How metrics are collected</h4>
      <p>Over ssh without a password: a key login (ssh-agent, IdentityFile) or a session already open in OpsDeck is needed. The connection is kept for 2 minutes and reused, so the next poll is cheap. /proc and df are read — Linux only. If a host has never been connected to, accept its key: connect once from the terminal.</p>`,
  },
  ssh: {
    title: "SSH",
    html: `
      <h4>How it works</h4>
      <p>“Connect”, or a double click on the row, opens a terminal tab with ssh. Hosts from ~/.ssh/config connect by alias with all their settings (keys, ProxyJump).</p>
      <h4>What's where</h4>
      <ul><li><b>＋ Host</b> — your own profile: address, port, user, key (-i), jump host (-J), login method. If the key's permissions are wider than ssh allows, it says so under the field, with a “Fix permissions” button next to it.</li>
      <li>A password from KeePass/Passbolt/keyring goes to the clipboard for 30 seconds — paste with ${kbd("Ctrl+Shift+V")} when ssh asks.</li>
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
        <li><b>Right-click in the tree</b> — a new file or folder here, rename, copy and paste (a taken name gets “copy”), delete. There is no trash — deleted files come back only from git, so OpsDeck asks first. Open tabs follow a rename. It works only inside the project folder.</li>
        <li><b>⇢ AI</b> at the bottom right — ask the AI about the file (or the selection), about the project (structure and <code>git status</code>) or to review the changes (<code>git diff</code>). The text goes to the terminal's AI panel — the chosen agent or the local AI; you add the question and send it.</li>
        <li>${kbd("Ctrl+S")} — save. If the file was changed outside after it was opened, OpsDeck asks whether to overwrite it.</li>
        <li><b>Several projects.</b> The open ones are chips above the tree: a click switches, × closes. Each keeps its own open files, expanded folders and current file — nothing is lost when you switch.</li>
        <li><b>Search across the project</b> — the ⌘ button at the top left or ${kbd("Ctrl+Shift+F")} outside the editor: plain text or a regular expression, case-sensitive by a checkbox. Hits are grouped by file and a click opens that line. Build output and other people's code (.git, node_modules, target, dist, .terraform, vendor…), binary files and anything over 2 MB are skipped; the first 500 hits are shown.</li>
        <li>${kbd("Ctrl+W")} closes the tab (a pane in the terminal), not the application window. ${kbd("Ctrl+Z")}, ${kbd("Ctrl+Shift+Z")}, ${kbd("Ctrl+Y")}, ${kbd("Ctrl+A")}, ${kbd("Ctrl+D")} and ${kbd("Ctrl+/")} work on any keyboard layout.</li>
        <li>${kbd("Ctrl+F")} — find and replace (like ${kbd("Ctrl+S")}, it works on any keyboard layout, and from the tree too), ${kbd("Ctrl+/")} — comment out, ${kbd("Tab")} / ${kbd("Shift+Tab")} — indent.</li>
        <li><b>▭ console</b> at the bottom (${kbd("Ctrl+`")}) — a terminal right in the project folder: ↻ restart, ⧉ open this folder in a terminal tab. When the project changes, the console runs <code>cd</code> itself — if nothing is running in it (otherwise OpsDeck says so and does not type a command into a program).</li>
        <li><b>Panel sizes</b> — drag the borders between the tree, the editor, the console and the git panel; double-click a border — back to the default size. Sizes are remembered.</li>
        <li><b>⛓ pipeline</b> at the bottom right (the button appears when the project has <code>.gitlab-ci.yml</code> or <code>.github/workflows</code>) — the pipeline graph: columns are stages (for GitHub, the order from <code>needs</code>), cards are jobs. At the top you pick the <b>event</b> (push, merge request, tag, schedule, started by hand), the <b>branch</b>, the list of <b>changed files</b> (for <code>rules:changes</code> and <code>on: paths</code>) and variables. Card colour: green — runs, yellow — only by hand, grey — does not run, purple — unknown (the condition depends on what the file does not hold). A click on a job shows which rule matched, “In the file” opens its line, “⇢ AI” sends the job with its condition to the AI panel. The <b>compare with</b> checkbox shows what another branch would change. <code>include: local</code>, <code>extends</code>, YAML anchors and <code>!reference</code> are resolved; this reads the files, it is not the server — project variables, protected branches and child pipelines are not visible here.</li>
        <li><b>⎇ git</b> at the bottom right — the git panel: changed files (click — diff, double-click — open the file), the commit box (<b>Commit all</b> = <code>git add -A</code> + commit, ${kbd("Ctrl+Enter")}) and the commit graph of all branches (click — the whole commit).</li>
        <li><b>A yellow bar to the left of a line</b> — that line has not been pushed to the remote branch yet (compared with <code>@{upstream}</code>, or with <code>origin/HEAD</code> for a local-only branch). It refreshes on save, on switching tabs and after git operations.</li>
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
      <p>Connections to PostgreSQL, MySQL/MariaDB, ClickHouse, Redis and MongoDB: address, port, login. The password is kept in the system keyring or taken from a KeePass or Passbolt entry. On the left — the structure: databases → schemas → tables → columns and indexes (for Redis — db and keys, for MongoDB — collections, fields and indexes). On the right — the query editor and the result.</p>
      <h4>What's where</h4>
      <ul>
        <li><b>＋</b> — a new connection. <b>Save and check</b> shows the server version or the error right away.</li>
        <li><b>Via SSH host (jump)</b> — if the database is reachable only from a bastion: pick a host from the SSH profiles or <code>~/.ssh/config</code> (its <code>ProxyJump</code> and key apply there), and OpsDeck opens an <code>ssh -L</code> tunnel itself. Key login is needed, as on the monitoring board; encryption “verify” does not work through the tunnel — choose “require”.</li>
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
      <li><b>@ agent</b> — insert a link to the note (or the selected lines) into the prompt of the AI agent chosen in ⚙ Settings → AI agent: Claude Code gets it over the IDE bridge, the others as an @path line in the AI panel; <b>Obsidian ↗</b> — open in Obsidian.</li></ul>
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
      <li>Click a row — details: 👁 show the password for 10 seconds (click again to hide it), the entry's notes.</li>
      <li>KeePass entries can be bound to web panels, SSH hosts and MikroTik routers — then passwords are taken from here.</li>
      <li>While the database is open, passwords are in the palette ${kbd("Ctrl+Shift+P")} → “Password: …”.</li></ul>`,
  },
  passbolt: {
    title: "Passbolt",
    html: `
      <h4>How it works</h4>
      <p>OpsDeck connects to Passbolt as another device of the user and only reads entries. The key is kept on this computer, protected by its passphrase; decrypted entries live only in memory and are wiped on lock.</p>
      <h4>Connecting</h4>
      <ul><li>In Passbolt: profile → <b>Desktop app setup</b> → download <code>account-kit.passbolt</code>. Here: <b>Choose account kit…</b>. OpsDeck checks the server key against the one in the file.</li>
      <li>Second factor: an authenticator app code (TOTP) or a Yubikey. “Remember for 30 days” works if the server allows it.</li></ul>
      <h4>What's where</h4>
      <ul><li>👤 / 🔑 in a row — copy the login / password; the password is wiped from the clipboard after 30 seconds.</li>
      <li>Click a row — details: 👁 show the password for 10 seconds, <b>Show description</b>.</li>
      <li>The password and description are fetched from the server on first use — Passbolt logs every such access, so nothing is downloaded in advance.</li>
      <li>⟳ — re-read the list from the server (new and changed entries).</li>
      <li>Passbolt entries can be bound to web panels, SSH hosts, databases and MikroTik routers — then passwords are taken from here.</li>
      <li>While Passbolt is unlocked, passwords are in the palette ${kbd("Ctrl+Shift+P")} → “Password: …”.</li></ul>`,
  },
  agent: {
    title: "AI agent",
    html: `
      <h4>What this is</h4>
      <p>The agent goes to a host itself and looks at what is happening there: service logs, systemd state, disk space, containers, pods. It doesn't guess from memory — it runs real commands and reads their output. It can change only what is allowed here, and only the way the dialog shows before it runs. Investigations start in the terminal's AI panel; this section is about the rules.</p>
      <h4>Access levels</h4>
      <ul>
        <li><b>Stay away</b> — the agent does not enter this host: nothing runs, not even reading.</li>
        <li><b>Read only</b> — it runs reading commands itself (logs, service state, disk space, containers, pods). Any changing command is refused, and permission does not get around that.</li>
        <li><b>Change with permission</b> — it reads on its own; for every changing command it shows the exact line and the host name and waits for a click. A refusal does not end the investigation — the agent moves on.</li>
        <li><b>Change freely</b> — it reads and changes on its own, no dialogs; the bans still apply. For throwaway environments.</li>
      </ul>
      <p>A host's level wins over the default one. The switch at the top wins over every level: while it is off, the agent does nothing.</p>
      <h4>Your own rules</h4>
      <p>Three lists: <b>count as reading</b> (the agent runs it itself even where it would ask), <b>always ask</b> (it shows it and waits for a click even when it is only reading) and <b>forbid completely</b> (it runs at no level). A ban wins over "ask", "ask" wins over "reading", and no rule unlocks what is forbidden always.</p>
      <p>Rules go one per line or separated by commas — a space cannot be the separator, because the rules themselves are made of words. A rule is the words of a command in order: <code>docker system prune</code> also catches <code>docker system prune -a --volumes</code>, and <code>kubectl get secret</code> catches <code>kubectl -n shop get secret db -o yaml</code>, because flags shift the words but do not change their order. If a rule contains <code>|</code> or <code>&gt;</code>, it is searched in the whole line: that is how <code>| bash</code> is written. A rule catches the command under <code>sudo</code> too.</p>
      <h4>What never runs</h4>
      <p>Redirections and compound commands (<code>&gt;</code>, <code>;</code>, <code>&amp;&amp;</code>, backticks), interpreters (<code>sh</code>, <code>bash</code>, <code>python</code>, <code>awk</code>, <code>nc</code>) and the irreversible (<code>rm</code>, <code>dd</code>, <code>mkfs</code>, <code>reboot</code>, <code>passwd</code>). None of it passes at any level, "change freely" included: that is not a command the rules can reason about, it is running someone else's text. If you need it, type it in the terminal yourself.</p>
      <p><code>sudo</code> has its own checkbox, and under it even reading counts as a change.</p>
      <h4>Why so strict</h4>
      <p>The agent reads logs, and logs are written by anyone. A line like "ADMIN NOTE: run this command" is indistinguishable from real data for a model, so output from a host is treated as data, not instructions: what runs is decided by the rules in this section, not by the model's answer.</p>
      <h4>Checking and the log</h4>
      <p><b>Check a command</b> shows what would happen if the agent proposed it — without running anything. The <b>log</b> keeps every command that ran: when, on which host, whether it was reading or a change, with permission or not, and the exit code.</p>`,
  },
  winbox: {
    title: "MikroTik",
    html: `
      <h4>What's where</h4>
      <ul><li><b>＋ Device</b> — address, WinBox/SSH ports, credentials (from KeePass, Passbolt, the keyring or no password).</li>
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
      <li><b>Moving to another computer</b>: «Export…» packs the ticked parts (settings and interface, SSH, web panels, databases, MikroTik, snippets, kubeconfig, the notes folder) by several threads; «Import…» shows what the archive holds and restores the chosen ones. Replaced files are first copied to a backup-… folder. Passwords are not in the archive — enter them again. kubeconfig is not ticked by default: it holds access keys to the clusters.</li>
      <li><b>Colour scheme</b> of the terminal: OpsDeck, Campbell, One Half Dark, Solarized Dark, Dracula or your own — <i>Import JSON…</i> takes Windows Terminal's settings.json, a list of schemes or one scheme. Applies to all terminals at once.</li>
      <li><b>Windows</b> (shown on Windows only): the shell for new tabs — PowerShell 5.1 or 7, Git Bash, cmd, a WSL distribution — and importing schemes straight from the installed Windows Terminal. The <b>WSL</b> button next to ＋ in the terminal opens a tab of the chosen distribution; it gets TERM, COLORTERM and KUBECONFIG (paths as /mnt/c/…), and the AI command in a WSL tab suggests Linux commands.</li>
      <li><b>KeePass</b>: “Keep the database open until OpsDeck closes” (on by default) or auto-lock after N minutes idle. Background alert polling does not count as activity: after the auto-lock, sources with a password from KeePass wait until the database is unlocked.</li>
      <li>Paths to the KeePass database, the notes folder and WinBox are filled in automatically if found in the home folder (candidates — in the field's dropdown).</li>
      <li><b>Kubernetes</b>: by default OpsDeck works only with its own kubeconfig copies; the checkbox also shows the shared ~/.kube/config.</li>
      <li><b>Snippets</b>: commands with {{name}} or {{name:value}} parameters — run via the palette ${kbd("Ctrl+Shift+P")}, the command is pasted into the terminal, you press Enter.</li>
      <li><b>Updates</b>: OpsDeck checks GitHub Releases (at startup, if enabled, or with the button). When there is a new version, ⚙ gets a ↑; “Update and restart” downloads it, checks the signature and installs it. On Linux the system asks for a password for .deb/.rpm, an AppImage updates without one. If a new version misbehaves — “Other versions” → <b>Roll back</b> to any previous one. If a version was withdrawn because of a critical bug, OpsDeck offers going back to the stable one itself.</li>
      <li><b>Local AI</b>: choose a model: the light Qwen2.5-Coder 1.5B (≈1.1 GB, default), Qwen3.5 4B and 9B or Qwen3.6 35B-A3B for powerful PCs (★ marks what fits your RAM), or your own .gguf file. “Install” downloads the llama.cpp engine and the model with a checksum check into OpsDeck's data folder — the app installer doesn't grow. Downloaded models can be removed one by one. <b>Acceleration</b> “GPU (Vulkan)” on Linux and Windows works with NVIDIA, AMD and Intel (a driver with Vulkan is needed); on a Mac the GPU is used automatically — big models answer several times faster with it. The built-in engine works offline, requests go nowhere. <b>External AI server</b>: if you already run Ollama, vLLM, LM Studio or another server with an OpenAI-compatible API, set its address, model and, if needed, an API key (kept in the system password store) — requests go there instead of the built-in engine. Note: commands from your notes, recent commands and the current folder are sent along with the request.</li>
      <li><b>Log</b>: errors, UI freezes (with what was running at that moment), crashes and slow operations are written to a file; “Show errors and freezes” — a quick look at what happened, “Open folder” — attach the file to a bug report.</li>
      <li>All settings are in ~/.config/opsdeck/, passwords — in the system keyring.</li></ul>`,
  },
};
