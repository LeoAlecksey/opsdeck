# OpsDeck

[![build](https://github.com/LeoAlecksey/opsdeck/actions/workflows/build.yml/badge.svg)](https://github.com/LeoAlecksey/opsdeck/actions/workflows/build.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Telegram](https://img.shields.io/badge/Telegram-sys__admin__expert-26A5E4?logo=telegram&logoColor=white)](https://t.me/sys_admin_expert)

**Единая рабочая панель DevOps-инженера**: терминал с AI рядом и локальной моделью, Kubernetes, базы данных, встроенная IDE с git, Grafana/ArgoCD/GitLab во вкладках, алерты, заметки с задачами и напоминаниями, KeePass, SSH и MikroTik — в одном нативном приложении для Linux, Windows и macOS.

🌐 **Сайт с обзором и инструкцией:** https://leoalecksey.github.io/opsdeck/ ([English](https://leoalecksey.github.io/opsdeck/en/))

> *English:* runs on Linux (glibc 2.35+, e.g. Ubuntu 22.04+, Debian 12+, Fedora 36+), Windows 10/11 and macOS 10.13+ (Apple Silicon: 11+). OpsDeck is an open-source desktop cockpit for DevOps engineers — a Warp-style terminal with an AI side panel (Claude Code, Codex, Gemini, Aider, OpenCode), a Lens-like Kubernetes view, embedded Grafana/ArgoCD/GitLab tabs with auto-login, an alert inbox (Grafana, Prometheus Alertmanager, your own AI analyzers), KeePass, SSH/MikroTik launchers and a Markdown notes vault. Built with Rust + Tauri 2. MIT licensed.

Стек: **Rust + [Tauri 2](https://tauri.app)** (бэкенд), TypeScript + Vite (интерфейс), [xterm.js](https://xtermjs.org) (терминал), [kube-rs](https://kube.rs) (Kubernetes).

---

## Возможности

### Терминал «как Warp» + AI рядом
- Вкладки и сплиты, настоящий shell (bash/zsh/PowerShell).
- **Блоки команд**: у каждой команды — код выхода и время, панель действий (скопировать команду/вывод, сохранить как сниппет, отправить в AI), плашка «спросить AI» при ошибке, навигация по командам.
- **AI-панель** справа: Claude Code, Codex, Gemini, Aider или OpenCode в своём терминале; выделенный текст или вывод команды отправляется туда одной клавишей.
- **Интеграция с Claude Code как IDE**: `claude`, запущенный в OpsDeck, подключается к нему сам (MCP по WebSocket на 127.0.0.1) — видит выделение в заметках и получает ссылки на них.
- **Строка ресурсов** внизу: CPU, load, RAM, диск — этой машины или удалённой в активной SSH-сессии.
- **Запись сессии** в текстовый файл кнопкой ⏺.
- **Палитра команд** `Ctrl+Shift+P`: разделы, кластеры, хосты, заметки, пароли, история команд, сниппеты с параметрами `{{имя}}`.
- **Подсказка при наборе**, как в fish: продолжение команды серым из истории bash/zsh и блоков кода в заметках, `→` — принять.
- **Локальный ИИ** `Ctrl+Shift+K`: опишите словами, что сделать, — получите команду с учётом ваших заметок и истории. Модель на движке llama.cpp ставится из настроек по желанию и работает без интернета: лёгкая Qwen2.5-Coder 1.5B (≈1,1 ГБ) по умолчанию, Qwen3.5 4B/9B и Qwen3.6 35B-A3B для мощных ПК или свой файл `.gguf`; ускорение на видеокарте (Vulkan на Linux/Windows, Metal на Mac). Можно подключить и свой сервер с OpenAI-совместимым API — Ollama, vLLM, LM Studio (ключ хранится в системном хранилище паролей).
- **Шрифт терминала**: ⚙ → Терминал. Список популярных моноширинных шрифтов (неустановленные помечены), для иконок Powerlevel10k — MesloLGS NF или Nerd Font; любой другой — пункт «Другой…». Применяется сразу ко всем терминалам.
- **Подсветка** команды при наборе и вывода (ERROR/WARN, статусы подов, IP, ссылки), **панель файлов** с git-статусом, `Ctrl`+клик по пути в выводе открывает файл на строке.

### Kubernetes (в духе Lens)
- Собственное хранилище kubeconfig (ваш `~/.kube/config` не меняется): импорт выбранных контекстов, вставка YAML, drag & drop файлов.
- Живые таблицы (watch), CPU/RAM из metrics-server, любые CRD с колонками как у `kubectl get`.
- Логи пода и **сразу всех подов** Deployment/StatefulSet/DaemonSet/Job с фильтрами; вкладка «Детали» со ссылками на связанные объекты; YAML с server-side apply.
- Shell, port-forward, scale, restart, delete; Helm-релизы (values, история, rollback) и Argo CD Applications (sync/refresh).
- Режим **«только чтение»** для продовых контекстов — изменения блокирует бэкенд.

### Базы данных
- PostgreSQL, MySQL/MariaDB, ClickHouse, Redis, MongoDB: подключение по адресу и порту, пароль из keyring, KeePass или Passbolt, TLS.
- Дерево структуры (базы → схемы → таблицы → колонки и индексы), редактор запросов с историей, таблица результатов, копирование в CSV/JSON.
- Режим **«только чтение»** для прод-баз: PostgreSQL и ClickHouse запрещают запись на стороне сервера.

### IDE и git
- Редактор с подсветкой (Terraform/HCL, YAML, JSON, TS/JS, Python, Go, Rust, SQL, Shell, Dockerfile…), свои иконки файлов, дерево проекта.
- Ошибки YAML/JSON/Terraform прямо в коде, `terraform fmt` при сохранении.
- Панель git: граф коммитов всех веток, диффы, ветки (переключить, создать, слить, удалить), fetch/pull/push, коммит. Мини-консоль в папке проекта.

### Веб-панели и алерты
- Grafana, ArgoCD, GitLab и любые сайты — **вкладками внутри окна** с автоматическим входом (пароль из keyring, KeePass или Passbolt).
- **Алерты** 🔔: OpsDeck сам опрашивает Grafana Alerting, Prometheus Alertmanager и JSON-ленты ваших AI-анализаторов — на машину ничего не нужно пробрасывать. Уведомления на рабочем столе, история, ссылки на панели/silence, разбор алерта в AI.
- **Свой AI-анализатор** логов и алертов может присылать находки на `127.0.0.1` по токену — в приложении есть готовая инструкция и пример `curl`.

### Остальное
- **Модули**: кнопка ⊞ в колонке слева включает и выключает разделы галочками — оставьте только нужные. В новой установке включены Терминал, Kubernetes, SSH, KeePass и Заметки; выключенные разделы не загружаются.
- **KeePass** (.kdbx): только чтение, база лишь в памяти; остаётся открытой до закрытия OpsDeck (или автоблокировка) и сама подтягивает изменения файла. Пароли копируются с автоочисткой буфера и служат источником для всех разделов.
- **Passbolt** (5.x): только чтение — вход по account kit, второй фактор TOTP или Yubikey, список записей с папками и поиском, копирование логина и пароля, палитра. Пароль запрашивается с сервера только при использовании (Passbolt пишет каждое обращение в журнал), расшифрованное — лишь в памяти до блокировки.
- **SSH**: профили (ключ, jump-хост, пароль из KeePass или Passbolt) и хосты из `~/.ssh/config`.
- **MikroTik**: WinBox и SSH в один клик.
- **Заметки**: несколько хранилищ (свои или Obsidian vault), дерево папок с перетаскиванием, теги, поиск, редактор Markdown.
- **Задачи и напоминания**: задачи строками в заметках (формат Obsidian Tasks), общий список по срокам, календарь, всплывающие напоминания с «отложить».
- **Сеть и DNS**: ping, mtr, traceroute, dig, nslookup; скан портов хоста (открыт/закрыт/фильтруется и что отвечает) и список портов, которые слушает эта машина, с процессами.

В каждом разделе есть кнопка **!** — встроенная подсказка: как работает, что где нажимать, горячие клавиши.

**Языки интерфейса:** русский и английский (⚙ → Язык; по умолчанию — как в системе). *The interface is available in English: ⚙ Settings → Language.*

---

## Установка

### Системные требования

| ОС | Версии | Примечания |
|---|---|---|
| **Linux** (x64, ARM64) | Ubuntu 22.04+ (Mint 21+, Pop!_OS 22.04+), Debian 12+, Fedora 36+, openSUSE Tumbleweed, Arch/Manjaro | Нужны glibc 2.35+ и WebKitGTK 4.1. **Не подходят:** Ubuntu 20.04, Debian 11, RHEL/Alma/Rocky 9 (glibc 2.34). |
| **Windows** (x64) | Windows 10 и 11 | Нужен WebView2: в Windows 11 и обновлённой Windows 10 он уже есть, иначе установщик скачает его сам. Windows 7/8 не поддерживаются. |
| **macOS** | Intel: 10.13 High Sierra+; Apple Silicon (M1–M4): 11 Big Sur+ | Сборки пока не подписаны — см. ниже. |

Локальный ИИ (необязательный, ставится из ⚙) использует сборки [llama.cpp](https://github.com/ggml-org/llama.cpp) и может требовать систему новее; если он не запустится, остальное OpsDeck работает как обычно. Модели нужно ≈1,1 ГБ на диске и ≈1,5 ГБ свободной памяти во время работы.

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

Необязательные внешние программы: `kubectl`, `helm`, `ssh`, `mtr`/`traceroute`/`dig`, WinBox, KeePassXC, `claude`/`codex`/`gemini`/`aider` — OpsDeck использует их, если они установлены.

---

## Быстрый старт

1. **Kubernetes**: раздел ☸ → **＋** → отметьте нужные контексты из `~/.kube/config`. Для прода включите 🔒.
2. **Grafana и алерты**: раздел ◎ → **＋ Добавить** → тип Grafana, URL, авторизация «токен» (Service account с ролью Viewer) → **Сохранить и проверить**. Алерты появятся в 🔔.
3. **Терминал + AI**: `Ctrl+Shift+I` открывает AI-панель, `Ctrl+Shift+A` отправляет выделение, `Ctrl+Shift+P` — палитра.
4. **KeePass, заметки, WinBox**: пути подхватываются автоматически, проверить можно в ⚙.

---

## Обновления и выпуск версий

OpsDeck обновляется сам: при запуске (или кнопкой в ⚙ → «Обновления») проверяет GitHub Releases, и если есть новая версия — на ⚙ появляется ↑, а кнопка **«Обновить и перезапустить»** скачивает, **проверяет подпись** и ставит обновление (Windows, macOS, Linux: AppImage, `.deb`, `.rpm` — для пакетов система спросит пароль).

Выпуск новой версии — одна команда:
```bash
npm run release -- 0.2.0 "Что нового: …"
```
Скрипт поднимает версию в `package.json`, `tauri.conf.json`, `Cargo.toml`, делает коммит и тег `v0.2.0` с этим описанием и пушит. GitHub Actions собирает все платформы, подписывает обновления и **публикует релиз** с `latest.json` — установленные копии увидят его при следующей проверке.

Подпись: обновления подписываются приватным ключом (minisign) из секретов репозитория `TAURI_SIGNING_PRIVATE_KEY` и `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; публичный ключ зашит в `tauri.conf.json`, и приложение не установит файл с чужой подписью. Ключ создаётся командой `npx tauri signer generate -w ~/.tauri/opsdeck.key`. **Храните ключ и пароль в надёжном месте** (например, в KeePass): без них выпустить обновление для уже установленных копий нельзя.

## Сборка в CI

`.github/workflows/build.yml` собирает на **нативных раннерах** — каждая платформа на своей ОС и архитектуре:

| Раннер | Что получается |
|---|---|
| `ubuntu-22.04` (x64), `ubuntu-22.04-arm` (arm64) | `.deb`, `.rpm`, `.AppImage` |
| `windows-latest` (x64) | `.msi`, установщик NSIS `.exe` |
| `macos-latest` (Apple Silicon; сборка для Intel — там же, с `--target x86_64-apple-darwin`) | `.dmg`, `.app` |

- Пуш в `main`/`master` (бывает только при релизе): проверки и сборка всех платформ без публикации — она же заполняет кэш Rust, из которого следующий релиз берёт уже собранные зависимости.
- Pull request в `master`: проверки (TypeScript, `npm audit`, `cargo audit`) и быстрая сборка только linux-x64; установщик — в артефактах запуска (Actions → запуск → Artifacts).
- Ветка `dev` сама не собирается; ручной запуск (Run workflow) собирает linux-x64 или, с галкой, все платформы.
- Тег `v*` (удобнее через `npm run release -- 0.2.0 "что нового"`): все платформы, релиз собирается черновиком и **публикуется** (со всеми установщиками, подписанными обновлениями и `latest.json`) только после того, как прошли проверки, все сборки и все тесты.
- **Тесты** (на тегах, пушах в master, PR в master и ручном запуске): тесты Rust на Linux, Windows и macOS (`cargo test --lib`); тесты интерфейса — vitest (`npm test`) и Playwright на демо-данных (`npm run test:ui`, все разделы, кнопки и переводы); сквозные тесты настоящего приложения через tauri-driver на Linux и Windows (`tests/e2e`: настоящий shell, вкладки, `exit`, ping, модули). Упали тесты — релиз остаётся черновиком.
- Windows на ARM не собирается: таких пользователей слишком мало.
- **Аварийный откат**: если версия вышла с критической ошибкой — Actions → «Отозвать версию» → номер версии. Релиз становится pre-release, «последним» снова становится предыдущий стабильный; установленные копии с отозванной версией предложат вернуться на него (⚙ → Обновления). Там же пользователь может вручную поставить любую из прошлых версий («Другие версии»).
- arm64-раннеры Linux бесплатны для публичных репозиториев; в приватном их может не быть на вашем тарифе — тогда уберите `linux-arm64` из списка платформ в job `plan`.
- Dependabot (`.github/dependabot.yml`) раз в месяц присылает в `dev` общие PR с обновлениями зависимостей (мажорные версии — вручную).

---

## Архитектура

```
src/                  интерфейс (TypeScript, без фреймворка)
  modules/            разделы: terminal, k8s, connectors (веб-панели), alerts, keepass, passbolt, notes, ssh, …
src-tauri/src/        бэкенд на Rust
  pty.rs              терминалы (portable-pty) + интеграция shell (OSC 133)
  k8s.rs              Kubernetes (kube-rs): списки, watch, логи, Helm, CRD
  embed.rs            встраивание веб-панелей во вкладки
  alerts.rs           сбор алертов и находок AI
  ide.rs              мост для Claude Code (MCP по WebSocket, 127.0.0.1)
  keepass.rs, passbolt.rs, ssh.rs, mikrotik.rs, notes.rs, connectors.rs, tools.rs, store.rs, …
```

Данные пользователя: `~/.config/opsdeck/` (права 600/700), секреты — в системном хранилище (Secret Service / Keychain / Credential Manager).

---

## Безопасность

- Секреты — только в системном хранилище или KeePass; база KeePass и записи Passbolt расшифрованы лишь в памяти; пароли в буфере стираются через 30 с.
- OpsDeck не слушает внешние интерфейсы: мост для Claude Code и приём находок AI — только `127.0.0.1`, по токену, с защитой от запросов из браузера и DNS rebinding.
- Встроенные веб-страницы не имеют доступа к API приложения; автологин работает только на адресе коннектора.
- Строгая CSP интерфейса, экранирование всех внешних данных, Markdown через DOMPurify.
- Внешние программы запускаются без shell, аргументы валидируются; при импорте kubeconfig с `exec` показываются запускаемые им команды.
- В CI — `npm audit` и `cargo audit` на каждую сборку, Dependabot для зависимостей.

Нашли уязвимость? См. [SECURITY.md](SECURITY.md).

---

## Известные ограничения

- Веб-панели — нативные webview поверх интерфейса: пока фокус внутри панели, горячие клавиши OpsDeck не срабатывают. Если встраивание ведёт себя странно, запустите с `OPSDECK_NO_EMBED=1` — панели будут открываться отдельными окнами.
- SSO-вход (Keycloak, Google) и 2FA в веб-панелях проходятся вручную один раз.
- Блоки команд работают в bash и zsh; в PowerShell терминал работает без блоков. На Windows обычно нет `mtr` и `dig`.
- WinBox принимает пароль только аргументом командной строки — пока он запущен, пароль виден в списке процессов вашего пользователя.

---

## Участие

[Issues](https://github.com/LeoAlecksey/opsdeck/issues) и pull requests приветствуются — как собрать, проверить и прислать изменения, написано в [CONTRIBUTING.md](CONTRIBUTING.md).

## Автор и поддержка

- Telegram-канал автора: [@sys_admin_expert](https://t.me/sys_admin_expert)
- Если OpsDeck пригодился — можно [поддержать проект](https://yoomoney.ru/to/4100119645604976) (ЮMoney). Спасибо!

## Лицензия

[MIT](LICENSE) © 2026 [LeoAlecksey](https://github.com/LeoAlecksey)
