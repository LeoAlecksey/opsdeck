import { helpBtn } from "./help";
import { langSetting, locale, setLang, t } from "../i18n";
import { invoke } from "@tauri-apps/api/core";
import { ask, esc, toast } from "./ui";
import { mountSnippets } from "./snippets";
import { mountUpdates } from "./updates";
import { hlPrefs, setHlPrefs } from "./highlight";
import { setTermFontSize, termFontSize, setTermFontFamily, termFontFamily, TERM_FONTS, fontInstalled } from "./pty";
import { setSuggestEnabled, suggestEnabled } from "./suggest";
import { AI_PROVIDERS, aiAgent, setAiAgent } from "./ai-agents";
import { addThemes, allThemes, currentThemeName, isWindows, parseSchemes, setTheme } from "./themes";
import { listen } from "@tauri-apps/api/event";
import { cleanPath } from "./paths";

const AUTHOR_TG = "https://t.me/sys_admin_expert";
const REPO_URL = "https://github.com/LeoAlecksey/opsdeck";
const DONATE_URL = "https://yoomoney.ru/to/4100119645604976";

type AiStatus = { engine: boolean; model: boolean; running: boolean; installing: boolean; size: number; download_size: number; dir: string; supported: boolean; model_title: string };
type AiModels = { models: { id: string; title: string; size: number; ram_gb: number; installed: boolean }[]; selected: string; custom_path: string; ram_total: number; gpu: boolean; gpu_supported: boolean; vulkan_found: boolean; metal: boolean; gpu_failed: boolean };
// sizes in decimal GB, like download pages show them; RAM in GiB, like the OS shows it
const GB = 1e9;
const GiB = 1073741824;
const gb = (b: number) => `${(b / GB).toFixed(1)} ГБ`;

/** Choose / install / remove the local model, with download progress. */
function mountAi(el: HTMLElement) {
  let title = "";
  const draw = async () => {
    const [st, ms] = await Promise.all([invoke<AiStatus>("ai_status").catch(() => null), invoke<AiModels>("ai_models").catch(() => null)]);
    if (!st || !ms) { el.textContent = "статус недоступен"; return; }
    title = st.model_title;
    if (!st.supported) { el.innerHTML = `<p class="muted">Для этой платформы встроенной модели пока нет.</p>`; return; }
    const ready = st.engine && st.model;
    // the biggest model that fits this machine's RAM (a little slack: the OS reports a bit less)
    const best = [...ms.models].reverse().find((m) => ms.ram_total >= m.ram_gb * GiB * 0.9)?.id ?? ms.models[0].id;
    const custom = ms.selected === "custom";
    const others = ms.models.filter((m) => m.installed && m.id !== ms.selected);
    el.innerHTML = `
      <label>Модель <select class="ai-model" data-no-i18n ${st.installing ? "disabled" : ""}>
        ${ms.models.map((m) => `<option value="${m.id}" ${m.id === ms.selected ? "selected" : ""}>${esc(t(m.title))} · ${(m.size / GB).toFixed(1)} ${t("ГБ")} · ${t("ОЗУ от")} ${m.ram_gb} ${t("ГБ")}${m.installed ? ` · ${t("скачана")}` : ""}${m.id === best ? ` · ${t("★ для вашего ПК")}` : ""}</option>`).join("")}
        <option value="custom" ${custom ? "selected" : ""}>${t("Свой файл .gguf…")}</option>
      </select></label>
      <div class="row ai-custom" ${custom ? "" : "hidden"}>
        <input class="ai-custom-path" placeholder="/путь/к/модели.gguf" spellcheck="false" value="${esc(ms.custom_path)}" />
        <button type="button" class="ghost" data-ai="pick">Выбрать…</button>
        <button type="button" class="primary" data-ai="use-custom">Использовать</button>
      </div>
      ${ms.metal ? `<p class="muted hint">Ускорение: видеокарта Apple (Metal) используется автоматически.</p>`
        : ms.gpu_supported ? `<label>Ускорение <select class="ai-gpu" ${st.installing ? "disabled" : ""}>
            <option value="cpu" ${ms.gpu ? "" : "selected"}>Процессор</option>
            <option value="gpu" ${ms.gpu ? "selected" : ""}>Видеокарта (Vulkan)</option>
          </select></label>
          ${ms.gpu && ms.gpu_failed ? `<p class="muted hint warn">Видеокарта не запустилась — модель работает на процессоре. Чтобы попробовать снова, переключите ускорение туда и обратно.</p>` : ""}
          ${ms.gpu && !ms.vulkan_found ? `<p class="muted hint warn">Драйвер Vulkan не найден — установите драйвер видеокарты (Linux: пакет libvulkan1 / vulkan-loader) или выберите «Процессор».</p>` : ""}` : ""}
      <p class="muted hint">В памяти компьютера: ${(ms.ram_total / GiB).toFixed(0)} ГБ. ${ms.gpu || ms.metal ? "На видеокарте модель отвечает в разы быстрее; если видеопамяти мало, часть модели остаётся на процессоре." : "Модели крупнее 1.5B на процессоре отвечают медленнее (несколько секунд и дольше) — включите ускорение на видеокарте, если она есть."}</p>
      <div class="row"><span>${ready ? `✓ Готов${st.running ? " · модель загружена в память" : ""} · на диске ${gb(st.size)}` : st.installing ? "Скачивается…" : `Не установлен · скачать ≈${gb(st.download_size)}`}</span>
        <span class="spacer"></span>
        ${st.installing ? `<button type="button" class="ghost" data-ai="cancel">Отменить</button>`
        : ready ? `${custom ? "" : `<button type="button" class="ghost" data-ai="remove-model" data-id="${ms.selected}">Удалить модель</button>`}<button type="button" class="ghost" data-ai="remove">Удалить всё</button>`
          : custom ? "" : `<button type="button" class="primary" data-ai="install">${st.size > 0 ? "Скачать" : "Установить"}</button>`}</div>
      ${others.length ? `<div class="muted ai-others">Ещё скачаны: ${others.map((m) => `${esc(t(m.title))} (${(m.size / GB).toFixed(1)} ${t("ГБ")}) <button type="button" class="link" data-ai="remove-model" data-id="${m.id}">удалить</button>`).join(", ")}</div>` : ""}
      <div class="upd-progress ai-prog" ${st.installing ? "" : "hidden"}><div class="upd-bar"></div></div>
      <div class="ai-stage muted" data-no-i18n></div>
      <div class="muted small-path" title="Папка с движком и моделями">${esc(st.dir)}</div>`;
  };
  el.addEventListener("change", async (e) => {
    const gpu = (e.target as HTMLElement).closest<HTMLSelectElement>(".ai-gpu");
    if (gpu) {
      try { await invoke("ai_set_gpu", { on: gpu.value === "gpu" }); } catch (err) { toast(String(err), "err"); }
      return draw();
    }
    const sel = (e.target as HTMLElement).closest<HTMLSelectElement>(".ai-model");
    if (!sel) return;
    if (sel.value === "custom") { el.querySelector<HTMLElement>(".ai-custom")!.hidden = false; return; }
    try { await invoke("ai_select", { model: sel.value }); } catch (err) { toast(String(err), "err"); }
    await draw();
  });
  el.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-ai]");
    const a = btn?.dataset.ai;
    try {
      if (a === "install") { await invoke("ai_install"); await draw(); }
      if (a === "cancel") await invoke("ai_cancel");
      if (a === "pick") {
        const p = await invoke<string | null>("ai_pick_model");
        if (p) el.querySelector<HTMLInputElement>(".ai-custom-path")!.value = p;
      }
      if (a === "use-custom") {
        await invoke("ai_select", { model: "custom", customPath: el.querySelector<HTMLInputElement>(".ai-custom-path")!.value });
        toast("Своя модель выбрана — загрузится при следующем запросе");
        await draw();
      }
      if (a === "remove-model") {
        if ((await ask("Удалить модель", "Удалить файл этой модели? Движок и другие модели останутся.", { ok: "Удалить", danger: true })) === null) return;
        await invoke("ai_remove_model", { id: btn!.dataset.id });
        await draw();
      }
      if (a === "remove") {
        if ((await ask("Удалить локальный ИИ", "Удалить движок и все скачанные модели? Потом их можно скачать снова.", { ok: "Удалить", danger: true })) === null) return;
        await invoke("ai_remove");
        await draw();
      }
    } catch (err) { toast(String(err), "err"); }
  });
  listen<{ stage: string; done: number; total: number }>("ai-progress", (e) => {
    const p = e.payload;
    const bar = el.querySelector<HTMLElement>(".ai-prog");
    if (bar) { bar.hidden = false; (bar.firstElementChild as HTMLElement).style.width = p.total ? `${(100 * p.done) / p.total}%` : "5%"; }
    const s = el.querySelector(".ai-stage");
    if (s) s.textContent = `${p.stage === "engine" ? t("Движок llama.cpp") : `${t("Модель")}: ${t(title)}`} — ${(p.done / 1048576).toFixed(0)}${p.total ? ` / ${(p.total / 1048576).toFixed(0)}` : ""} ${t("МБ")}`;
  });
  listen("ai-fallback", () => {
    toast("Видеокарта недоступна — локальный ИИ работает на процессоре");
    draw();
  });
  listen<{ ok: boolean; error?: string }>("ai-installed", (e) => {
    if (e.payload.ok) toast("Локальный ИИ установлен — в терминале Ctrl+Shift+K или кнопка ✦ ИИ");
    else toast(`Локальный ИИ: ${e.payload.error}`, "err");
    draw();
  });
  window.addEventListener("view-shown", (e) => { if ((e as CustomEvent).detail === "settings") draw(); });
  draw();
}

type Settings = {
  keepass_path: string; keepass_keyfile: string; keepass_lock_minutes: number; keepass_keep_open: boolean;
  obsidian_vault: string; winbox_path: string; k8s_include_system: boolean; update_auto_check: boolean;
  ai_host: string; ai_port: string; ai_model: string;
  /** only sent when the user typed a new key; the saved one stays in the OS keyring */
  ai_api_key?: string; ai_key_saved?: boolean;
  /** Windows: shell for new tabs ("" — PowerShell) */
  term_shell: string;
};
type WinShell = { id: string; label: string; program: string; args: string[] };
type Detected = { keepass: string[]; obsidian: string[]; winbox: string[] };
type VaultCheck = { ok: boolean; exists: boolean; is_dir: boolean; is_obsidian: boolean; md_count: number; path: string; err?: string | null };

export function mountSettings(root: HTMLElement) {
  root.innerHTML = `
    <div class="page settings">
      <h2>Настройки ${helpBtn("settings")}</h2>
      <fieldset class="lang-field" data-no-i18n><legend>Язык · Language</legend>
        <select class="lang-sel">
          <option value="auto">Как в системе · System</option>
          <option value="ru">Русский</option>
          <option value="en">English</option>
        </select>
      </fieldset>
      <form>
        <fieldset><legend>KeePass</legend>
          <label>База .kdbx <input name="keepass_path" list="dl-kp" spellcheck="false" /></label>
          <label>Ключевой файл (необязательно) <input name="keepass_keyfile" spellcheck="false" /></label>
          <label class="check"><input type="checkbox" name="keepass_keep_open" /> Держать базу открытой до закрытия OpsDeck (пароль вводится один раз за запуск)</label>
          <label>Автоблокировка, минут без действий (0 — выключить; работает, если галочка выше снята) <input name="keepass_lock_minutes" type="number" min="0" max="1440" /></label>
          <p class="muted hint">Пока база открыта, OpsDeck следит за файлом .kdbx: изменения, сохранённые в KeePassXC или пришедшие синхронизацией, подтягиваются сами.</p>
        </fieldset>
        <fieldset class="hl-field"><legend>Терминал</legend>
          <label class="check"><input type="checkbox" data-hl="input" /> Подсветка команды при наборе (как в fish: несуществующая команда — красным)</label>
          <label class="check"><input type="checkbox" data-hl="output" /> Подсветка вывода: ERROR/WARN, статусы подов, IP, ссылки, время</label>
          <label class="check"><input type="checkbox" class="term-sugg" /> Подсказывать продолжение команды серым (из истории и заметок), → — принять</label>
          <label>Размер шрифта (8–32; ещё Ctrl+= / Ctrl+- / Ctrl+0 и Ctrl+колесо в терминале) <input class="term-font" type="number" min="8" max="32" /></label>
          <label>Шрифт терминала <select class="term-font-family"></select></label>
          <label class="term-font-custom-row" hidden>Название шрифта <input class="term-font-custom" maxlength="128" spellcheck="false" placeholder="например, Iosevka" data-no-i18n /></label>
          <p class="muted hint term-font-warn" hidden></p>
          <div class="theme-row"><label>Цветовая схема <select class="term-theme"></select></label>
            <button type="button" class="ghost" data-theme-import>Импорт JSON…</button></div>
          <div class="theme-import" hidden>
            <textarea class="theme-json" rows="6" spellcheck="false" data-no-i18n placeholder='{"name": "My scheme", "background": "#101010", "foreground": "#e0e0e0", "red": "#ff5555", …}'></textarea>
            <div class="row"><button type="button" class="primary" data-theme-add>Добавить схемы</button><button type="button" class="ghost" data-theme-cancel>Отмена</button></div>
            <p class="muted hint">Формат схем Windows Terminal: весь settings.json (берётся список schemes), список схем или одна схема. Цвета — #rrggbb.</p>
          </div>
          <p class="muted hint">Шрифты из списка, которых нет в системе, помечены «не установлен» — их нужно поставить отдельно, иначе используется запасной. Для иконок Powerlevel10k — MesloLGS NF или Nerd Font. Любой другой установленный шрифт — пункт «Другой…». Выбор сохраняется и сразу применяется ко всем терминалам, включая SSH и AI.</p>
          <p class="muted hint">Применяется сразу. Подсветка ввода работает в локальных вкладках (нужна интеграция с bash/zsh). Вывод, который программа уже раскрасила сама, и полноэкранные программы (vim, htop, less) не трогаются.</p>
        </fieldset>
        <fieldset class="win-field" hidden><legend>Windows</legend>
          <label>Оболочка для новых вкладок <select name="term_shell"><option value="">Windows PowerShell (по умолчанию)</option></select></label>
          <p class="muted hint">Найдены установленные: PowerShell 5.1 и 7, Git Bash, cmd и дистрибутивы WSL. Применяется к новым вкладкам после «Сохранить». WSL можно открыть и разово — кнопка WSL рядом с ＋ в терминале.</p>
          <div class="row"><button type="button" class="ghost" data-wt-import>Импорт схем из Windows Terminal</button></div>
        </fieldset>
        <fieldset class="agent-field"><legend>AI-агент</legend>
          <label>Агент по умолчанию <select class="ai-agent-sel"></select></label>
          <p class="muted hint">Открывается в AI-панели терминала (Ctrl+Shift+I), получает выделенный текст (Ctrl+Shift+A), логи и алерты (⇢ AI) и ссылки на заметки (кнопка «@» в заметках). Сам агент (claude, codex, gemini, aider, opencode) ставится отдельно.</p>
        </fieldset>
        <fieldset class="ai-field"><legend>Локальный ИИ</legend>
          <div class="ai-root"></div>
          <p class="muted hint">Модель и движок llama.cpp скачиваются отдельно (по умолчанию — лёгкая Qwen2.5-Coder 1.5B, ≈1,1 ГБ; для мощных ПК есть модели крупнее, можно указать и свой файл .gguf) и работают только на этом компьютере — запросы никуда не уходят. В терминале ${"Ctrl+Shift+K"} или кнопка «✦ ИИ»: опишите словами, что сделать, — ИИ предложит команду с учётом ваших заметок и истории. Модель запускается при первом запросе и выгружается из памяти через 15 минут без дела.</p>
        <hr />
          <div class="ai-remote">
            <p class="muted">Внешний ИИ-сервер (Ollama, vLLM, LM Studio — любой с OpenAI-совместимым /v1)</p>
            <div class="ai-remote-row">
              <label class="ai-remote-host">Адрес <input name="ai_host" spellcheck="false" placeholder="localhost" /></label>
              <label>Порт <input name="ai_port" type="number" min="1" max="65535" placeholder="11434" /></label>
              <label class="ai-remote-model">Модель
                <span class="ai-model-wrap">
                  <input name="ai_model" spellcheck="false" class="ai-model-input" placeholder="qwen2.5-coder" autocomplete="off" />
                  <button type="button" class="ai-model-caret" data-ai-model-toggle aria-label="Список моделей">▾</button>
                  <ul class="ai-model-list" hidden></ul>
                </span>
              </label>
              <label>API-ключ <input name="ai_api_key" type="password" spellcheck="false" placeholder="необязательно" autocomplete="off" /></label>
              <button type="button" class="ghost" data-ai-key-clear hidden title="Удалить сохранённый ключ из хранилища паролей">Забыть ключ</button>
              <span class="spacer"></span>
              <button type="button" class="ghost" data-ai-test>Проверить</button>
            </div>
            <p class="muted hint">Заполнено — запросы идут на этот сервер вместо встроенного движка (кнопка «Проверить» запрашивает список моделей). Адрес может быть и полным URL (http://…). API-ключ хранится в системном хранилище паролей.</p>
            <p class="muted hint warn ai-remote-warn" hidden></p>
          </div>
        </fieldset>
        <fieldset class="notes-field"><legend>Заметки</legend>
          <label>Папка с заметками (Obsidian vault или любая папка с .md)
            <span class="row">
              <input name="obsidian_vault" list="dl-ob" spellcheck="false" placeholder="~/Documents/Notes" />
              <button type="button" class="ghost" data-pick="obsidian_vault">Обзор…</button>
            </span>
          </label>
          <p class="muted hint notes-path-status" hidden></p>
        </fieldset>
        <fieldset><legend>Kubernetes</legend>
          <label class="check"><input type="checkbox" name="k8s_include_system" /> Показывать и контексты из общего ~/.kube/config</label>
          <p class="muted hint">Выключено: OpsDeck работает только со своими копиями (＋ в разделе Kubernetes → «Добавить из ~/.kube/config»), и kubectl во вкладках OpsDeck видит только их. Ваш ~/.kube/config не меняется.</p>
        </fieldset>
        <fieldset><legend>Обновления</legend>
          <div class="upd-root"></div>
          <label class="check"><input type="checkbox" name="update_auto_check" /> Проверять при запуске</label>
          <p class="muted hint">Новые версии берутся из GitHub Releases проекта; каждое обновление подписано, и OpsDeck не установит файл с неверной подписью.</p>
        </fieldset>
        <fieldset><legend>MikroTik</legend>
          <label>WinBox <input name="winbox_path" list="dl-wb" spellcheck="false" /></label>
        </fieldset>
        <datalist id="dl-kp"></datalist><datalist id="dl-ob"></datalist><datalist id="dl-wb"></datalist>
        <div class="row"><button class="primary" type="submit">Сохранить</button><span class="muted detect-state"></span></div>
      </form>
      <fieldset class="xfer-field"><legend>Перенос на другой компьютер</legend>
        <p class="muted hint">Архив с выбранными частями: настройки и интерфейс, SSH, веб-панели, базы, MikroTik, сниппеты, kubeconfig, заметки. Пароли в архив не попадают — они в системном хранилище, после переноса их нужно ввести заново.</p>
        <div class="row"><button type="button" class="ghost" data-x="export">Экспорт…</button><button type="button" class="ghost" data-x="import">Импорт…</button></div>
        <dialog class="xfer-dlg">
          <form method="dialog">
            <h3 class="xfer-title"></h3>
            <p class="muted xfer-from"></p>
            <div class="xfer-parts"></div>
            <label class="xfer-notes" hidden>Куда положить заметки <input name="notes_dest" spellcheck="false" /></label>
            <p class="muted hint xfer-hint"></p>
            <p class="err xfer-err"></p>
            <div class="actions"><button value="cancel" formnovalidate>Отмена</button><button value="go" class="primary xfer-go"></button></div>
          </form>
        </dialog>
      </fieldset>
      <fieldset class="log-field"><legend>Журнал</legend>
        <p class="muted hint">Ошибки, зависания интерфейса (с командой, которая в этот момент выполнялась), падения и медленные операции пишутся в файл: <code class="log-path">…</code></p>
        <div class="row"><button type="button" class="ghost" data-log="problems">Показать ошибки и зависания</button><button type="button" class="ghost" data-log="all">Весь журнал (хвост)</button><button type="button" class="ghost" data-log="open">Открыть папку</button></div>
        <pre class="log-view" hidden></pre>
      </fieldset>
      <fieldset class="sn-field"><legend>Сниппеты</legend><div class="sn-root"></div></fieldset>
      <p class="muted">Конфиги: ~/.config/opsdeck/ · пароли коннекторов и роутеров — в системном keyring.</p>
      <p class="about muted">OpsDeck <span class="about-ver"></span> ·
        <a href="${AUTHOR_TG}" data-ext title="Telegram-канал автора">канал автора в Telegram</a> ·
        <a href="${REPO_URL}" data-ext title="Исходный код, задачи и релизы">GitHub</a> ·
        <a href="${DONATE_URL}" data-ext title="Перевод автору через ЮMoney — по желанию">поддержать проект</a></p>
    </div>`;

  const form = root.querySelector("form")!;
  const langSel = root.querySelector<HTMLSelectElement>(".lang-sel")!;
  langSel.value = langSetting();
  langSel.onchange = () => setLang(langSel.value as "auto" | "ru" | "en");
  invoke<string>("app_version").then((v) => (root.querySelector(".about-ver")!.textContent = `v${v}`)).catch(() => { });
  // links open in the system browser / Telegram, not inside the app window
  root.querySelector(".about")!.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-ext]");
    if (!a) return;
    e.preventDefault();
    invoke("open_external", { url: a.href }).catch((err) => toast(String(err), "err"));
  });
  mountSnippets(root.querySelector<HTMLElement>(".sn-root")!);
  mountUpdates(root.querySelector<HTMLElement>(".upd-root")!);
  const hlBoxes = root.querySelectorAll<HTMLInputElement>("[data-hl]");
  const syncHl = () => { const p = hlPrefs(); hlBoxes.forEach((b) => (b.checked = p[b.dataset.hl as "input" | "output"])); };
  hlBoxes.forEach((b) => (b.onchange = () => setHlPrefs({ [b.dataset.hl!]: b.checked })));
  window.addEventListener("term-highlight", syncHl);
  syncHl();
  const sugg = root.querySelector<HTMLInputElement>(".term-sugg")!;
  sugg.checked = suggestEnabled();
  sugg.onchange = () => setSuggestEnabled(sugg.checked);
  const agentSel = root.querySelector<HTMLSelectElement>(".ai-agent-sel")!;
  for (const name of Object.keys(AI_PROVIDERS)) agentSel.add(new Option(name, name));
  agentSel.value = aiAgent();
  agentSel.onchange = () => setAiAgent(agentSel.value);
  window.addEventListener("ai-agent", () => { agentSel.value = aiAgent(); });
  mountAi(root.querySelector<HTMLElement>(".ai-root")!);
  // внешний ИИ-сервер: «Проверить» → список моделей в выпадающий список поля «Модель»
  // (комбо-поле: можно и выбрать из списка, и ввести любую свою модель)
  const aiTest = (host: string, port: string, key: string) => invoke<{ models: string[] }>("ai_test", { host, port, apiKey: key });
  const modelIn = root.querySelector<HTMLInputElement>(".ai-model-input")!;
  const modelList = root.querySelector<HTMLElement>(".ai-model-list")!;
  let aiModels: string[] = [];
  const modelOpen = () => !modelList.hidden;
  const modelClose = () => (modelList.hidden = true);
  const modelRender = () => {
    const q = modelIn.value.trim().toLowerCase();
    const items = aiModels.filter((m) => !q || m.toLowerCase().includes(q));
    if (!items.length) return modelClose(); // свободный ввод: поле остаётся обычным полем
    modelList.innerHTML = items.map((m) => `<li data-m="${esc(m)}" class="${m === modelIn.value ? "sel" : ""}">${esc(m)}</li>`).join("");
    modelList.hidden = false;
  };
  modelIn.addEventListener("blur", modelClose); // клик по любому другому полю закрывает список
  modelIn.addEventListener("focus", () => { if (aiModels.length) modelRender(); });
  modelIn.addEventListener("input", () => { if (aiModels.length && modelOpen()) modelRender(); });
  modelIn.addEventListener("keydown", (e) => {
    if (modelList.hidden || (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Escape")) return;
    if (e.key === "Escape") return modelClose();
    e.preventDefault();
    const items = [...modelList.querySelectorAll<HTMLLIElement>("li[data-m]")];
    if (!items.length) return;
    const i = items.findIndex((li) => li.classList.contains("sel"));
    const n = e.key === "ArrowDown" ? (i + 1) % items.length : i === -1 ? items.length - 1 : (i - 1 + items.length) % items.length;
    items.forEach((li, k) => li.classList.toggle("sel", k === n));
    modelIn.value = items[n].dataset.m!;
  });
  modelList.addEventListener("mousedown", (e) => e.preventDefault()); // не отбирать фокус с поля
  modelList.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>(".ai-model-list li[data-m]");
    if (!li) return;
    modelIn.value = li.dataset.m!;
    modelClose();
  });
  root.querySelector<HTMLElement>("[data-ai-model-toggle]")!.addEventListener("click", (e) => {
    e.preventDefault();
    modelRender();
    modelIn.focus();
  });
  const fillAiModels = (models: string[]) => {
    aiModels = models;
    if (modelOpen()) modelRender();
  };
  root.querySelector<HTMLElement>("[data-ai-test]")!.addEventListener("click", async (e) => {
    const out = root.querySelector<HTMLElement>(".ai-remote .hint")!;
    e.preventDefault();
    const old = out.textContent!;
    out.textContent = "проверяю…";
    const r = await aiTest(f("ai_host").value, f("ai_port").value, f("ai_api_key").value).catch((err) => String(err));
    if (typeof r === "string") {
      out.textContent = old;
      toast(`Внешний ИИ: ${r}`, "err");
      return;
    }
    fillAiModels(r.models);
    out.textContent = `сервер отвечает · модели: ${r.models.length ? r.models.join(", ") : "(список пуст)"}`;
  });
  const fontIn = root.querySelector<HTMLInputElement>(".term-font")!;
  const syncFont = () => { fontIn.value = String(termFontSize()); };
  fontIn.onchange = () => { if (Number(fontIn.value)) setTermFontSize(Number(fontIn.value)); syncFont(); };
  window.addEventListener("term-font", syncFont);
  syncFont();
  const fontSel = root.querySelector<HTMLSelectElement>(".term-font-family")!;
  const fontCustomRow = root.querySelector<HTMLElement>(".term-font-custom-row")!;
  const fontCustom = root.querySelector<HTMLInputElement>(".term-font-custom")!;
  const fontWarn = root.querySelector<HTMLElement>(".term-font-warn")!;
  const OTHER = "__other__";
  const fillFonts = () => {
    fontSel.innerHTML = `<option value="">По умолчанию</option>` +
      TERM_FONTS.map((f) => `<option value="${esc(f)}">${esc(fontInstalled(f) ? f : `${f} — не установлен`)}</option>`).join("") +
      `<option value="${OTHER}">Другой…</option>`;
  };
  const showWarn = (name: string) => {
    fontWarn.hidden = !name || fontInstalled(name);
    fontWarn.textContent = fontWarn.hidden ? "" : `Шрифт «${name}» не найден в системе — терминал использует запасной.`;
  };
  const syncFontFamily = () => {
    const cur = termFontFamily();
    const known = !cur || TERM_FONTS.includes(cur);
    fontSel.value = known ? cur : OTHER;
    fontCustomRow.hidden = known;
    if (!known) fontCustom.value = cur;
    showWarn(cur);
  };
  fontSel.onchange = () => {
    if (fontSel.value === OTHER) {
      fontCustomRow.hidden = false;
      fontCustom.focus();
      return;
    }
    fontCustomRow.hidden = true;
    setTermFontFamily(fontSel.value);
  };
  fontCustom.onchange = () => setTermFontFamily(fontCustom.value);
  window.addEventListener("term-font-family", syncFontFamily);
  fillFonts();
  syncFontFamily();
  invoke<string>("logs_path").then((p) => (root.querySelector(".log-path")!.textContent = p)).catch(() => { });
  root.querySelector<HTMLElement>(".log-field")!.addEventListener("click", async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-log]")?.dataset.log;
    if (!act) return;
    if (act === "open") return void invoke("logs_open").catch((err) => toast(String(err), "err"));
    const view = root.querySelector<HTMLElement>(".log-view")!;
    view.hidden = false;
    view.textContent = "загрузка…";
    const text = await invoke<string>("logs_tail", { lines: 300, onlyProblems: act === "problems" }).catch((err) => String(err));
    view.textContent = text || t(act === "problems" ? "Проблем не записано ✓" : "Журнал пуст");
    view.scrollTop = view.scrollHeight;
  });
  const f = (n: keyof Settings) => form.elements.namedItem(n) as HTMLInputElement;

  async function load() {
    const s = await invoke<Settings>("settings_get");
    for (const k of Object.keys(s) as (keyof Settings)[]) {
      if (!f(k)) continue; // ai_key_saved: not a form field
      if (typeof s[k] === "boolean") f(k).checked = s[k] as boolean;
      else f(k).value = String(s[k] ?? "");
    }
    // the key itself never comes back from the backend: show whether one is saved
    f("ai_api_key").value = "";
    f("ai_api_key").placeholder = s.ai_key_saved ? "сохранён — введите новый, чтобы заменить" : "необязательно";
    root.querySelector<HTMLElement>("[data-ai-key-clear]")!.hidden = !s.ai_key_saved;
    remoteWarn();
    if (isWindows()) {
      const shells = await invoke<WinShell[]>("win_shells").catch(() => [] as WinShell[]);
      const sel = f("term_shell") as unknown as HTMLSelectElement;
      sel.innerHTML = `<option value="">Windows PowerShell (по умолчанию)</option>` +
        shells.filter((x) => x.id !== "powershell").map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join("");
      // a shell that is gone stays visible, so saving does not silently change it
      if (s.term_shell && !shells.some((x) => x.id === s.term_shell)) sel.insertAdjacentHTML("beforeend", `<option value="${esc(s.term_shell)}">${esc(s.term_shell)} — не найден</option>`);
      sel.value = s.term_shell ?? "";
    }
    root.querySelector(".detect-state")!.textContent = "ищу варианты в домашней папке…";
    const d = await invoke<Detected>("settings_detect").catch(() => null);
    root.querySelector(".detect-state")!.textContent = "";
    if (!d) return;
    const fill = (id: string, xs: string[]) => (root.querySelector(`#${id}`)!.innerHTML = xs.map((x) => `<option value="${esc(x)}">`).join(""));
    fill("dl-kp", d.keepass);
    fill("dl-ob", d.obsidian);
    fill("dl-wb", d.winbox);
    await checkVaultPath(f("obsidian_vault").value);
  }

  const notesStatus = root.querySelector<HTMLElement>(".notes-path-status")!;
  const checkVaultPath = async (raw: string) => {
    const cleaned = cleanPath(raw);
    if (!cleaned) {
      notesStatus.hidden = true;
      notesStatus.textContent = "";
      notesStatus.className = "muted hint notes-path-status";
      return null;
    }
    const check = await invoke<VaultCheck>("vault_validate_path", { path: cleaned }).catch((err) => ({
      ok: false,
      exists: false,
      is_dir: false,
      is_obsidian: false,
      md_count: 0,
      path: cleaned,
      err: String(err),
    }));
    notesStatus.hidden = false;
    if (check.ok) {
      notesStatus.className = "muted hint ok notes-path-status";
      const parts = [t("✓ Папка найдена")];
      if (check.is_obsidian) parts.push("Obsidian vault");
      else parts.push(t("папка с заметками"));
      if (check.md_count > 0) parts.push(`${check.md_count} ${t("заметок (.md)")}`);
      else parts.push(t("файлов .md пока нет"));
      notesStatus.textContent = parts.join(" · ");
    } else {
      notesStatus.className = "muted hint warn notes-path-status";
      notesStatus.textContent = `⚠ ${check.err ? t(check.err) : t("Папка не найдена")}`;
    }
    return check;
  };

  f("obsidian_vault").addEventListener("input", () => checkVaultPath(f("obsidian_vault").value));
  f("obsidian_vault").addEventListener("change", async () => {
    const val = cleanPath(f("obsidian_vault").value);
    if (!val) return;
    const check = await checkVaultPath(val);
    if (check && check.ok) {
      try {
        await invoke("vault_open", { path: val, name: null });
        window.dispatchEvent(new Event("settings-changed"));
        toast(t("Папка с заметками сохранена и подключена"));
      } catch (e) {
        toast(String(e), "err");
      }
    }
  });

  root.querySelector<HTMLElement>("[data-pick=obsidian_vault]")?.addEventListener("click", async () => {
    const cur = cleanPath(f("obsidian_vault").value);
    const picked = await invoke<string | null>("pick_folder", { start: cur || null }).catch(() => undefined);
    if (picked) {
      f("obsidian_vault").value = picked;
      const check = await checkVaultPath(picked);
      if (check && check.ok) {
        try {
          await invoke("vault_open", { path: cleanPath(picked), name: null });
          window.dispatchEvent(new Event("settings-changed"));
          toast(t("Папка с заметками сохранена и подключена"));
        } catch (e) {
          toast(String(e), "err");
        }
      }
    }
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    const vaultPath = cleanPath(f("obsidian_vault").value);
    if (vaultPath) {
      // a missing notes folder is reported, but does not keep the other settings from being saved
      const check = await checkVaultPath(vaultPath);
      if (check && !check.ok) toast(`${t("Папка с заметками не найдена — остальные настройки сохранены")}: ${check.err ? t(check.err) : vaultPath}`, "err");
      else await invoke("vault_open", { path: vaultPath, name: null }).catch((e) => toast(String(e), "err"));
    }
    const settings: Settings = {
      keepass_path: cleanPath(f("keepass_path").value), keepass_keyfile: cleanPath(f("keepass_keyfile").value),
      keepass_lock_minutes: Number(f("keepass_lock_minutes").value) || 0,
      keepass_keep_open: f("keepass_keep_open").checked,
      obsidian_vault: vaultPath, winbox_path: cleanPath(f("winbox_path").value),
      k8s_include_system: f("k8s_include_system").checked,
      update_auto_check: f("update_auto_check").checked,
      ai_host: f("ai_host").value.trim(), ai_port: f("ai_port").value.trim(), ai_model: f("ai_model").value.trim(),
      ai_api_key: f("ai_api_key").value.trim(),
      term_shell: f("term_shell").value,
    };
    try {
      await invoke("settings_set", { settings });
      toast("Настройки сохранены");
      load();
      window.dispatchEvent(new Event("settings-changed"));
    } catch (err) { toast(String(err), "err"); }
  };

  // external AI server: say plainly that requests leave the computer, and warn about plain http
  function remoteWarn() {
    const host = f("ai_host").value.trim(), model = f("ai_model").value.trim();
    const warn = root.querySelector<HTMLElement>(".ai-remote-warn")!;
    if (!host || !model) { warn.hidden = true; return; }
    const url = /^https?:\/\//.test(host) ? host : `http://${host}:${f("ai_port").value.trim() || "11434"}`;
    let hostname = host;
    try { hostname = new URL(url).hostname; } catch { /* keep as typed */ }
    const local = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i.test(hostname);
    // separate spans: each sentence is translated on its own
    warn.innerHTML = `<span>${local ? `Запросы ИИ идут на сервер на этом компьютере (${esc(url)}), встроенный движок не используется.`
      : `Запросы ИИ уходят на сервер ${esc(url)}: вместе с ними — команды из ваших заметок, недавние команды и текущая папка. Встроенный движок не используется.`}</span>`
      + (!local && url.startsWith("http://") ? ` <span>Соединение без шифрования: ключ и данные видны в сети — используйте https или сервер в доверенной сети.</span>` : "");
    warn.hidden = false;
  }
  for (const n of ["ai_host", "ai_port", "ai_model"] as const) f(n).addEventListener("input", remoteWarn);
  root.querySelector<HTMLElement>("[data-ai-key-clear]")!.addEventListener("click", async () => {
    if ((await ask("Забыть API-ключ", "Удалить сохранённый ключ внешнего ИИ-сервера из хранилища паролей?", { ok: "Удалить", danger: true })) === null) return;
    await invoke("ai_key_clear").catch(() => { });
    toast("Ключ удалён");
    load();
  });

  // ----- terminal colour schemes (stored in this profile, applied at once) -----
  const themeSel = root.querySelector<HTMLSelectElement>(".term-theme")!;
  const themeBox = root.querySelector<HTMLElement>(".theme-import")!;
  const themeJson = root.querySelector<HTMLTextAreaElement>(".theme-json")!;
  const fillThemes = () => {
    themeSel.innerHTML = allThemes().map((x) => `<option value="${esc(x.name)}">${esc(x.name)}</option>`).join("");
    themeSel.value = currentThemeName();
    if (themeSel.selectedIndex < 0) themeSel.selectedIndex = 0;
  };
  fillThemes();
  themeSel.addEventListener("change", () => setTheme(themeSel.value));
  const importThemes = (text: string) => {
    try {
      const list = parseSchemes(text);
      addThemes(list);
      fillThemes();
      themeSel.value = list[0].name;
      setTheme(list[0].name);
      toast(`${t("Добавлено схем")}: ${list.length}`);
      return true;
    } catch (err) { toast(t((err as Error).message), "err"); return false; }
  };
  root.querySelector<HTMLElement>("[data-theme-import]")!.addEventListener("click", () => { themeBox.hidden = !themeBox.hidden; if (!themeBox.hidden) themeJson.focus(); });
  root.querySelector<HTMLElement>("[data-theme-cancel]")!.addEventListener("click", () => { themeBox.hidden = true; });
  root.querySelector<HTMLElement>("[data-theme-add]")!.addEventListener("click", () => {
    if (importThemes(themeJson.value)) { themeJson.value = ""; themeBox.hidden = true; }
  });
  root.querySelector<HTMLElement>("[data-wt-import]")!.addEventListener("click", async () => {
    try { importThemes(await invoke<string>("wt_settings")); } catch (err) { toast(t(String(err)), "err"); }
  });
  // shells, WSL and Windows Terminal: only where they exist
  root.querySelector<HTMLElement>(".win-field")!.hidden = !isWindows();

  // ----- moving to another computer -----
  type Part = { id: string; label: string; files: number; bytes: number; default: boolean; warn: string };
  const xdlg = root.querySelector<HTMLDialogElement>(".xfer-dlg")!;
  const xform = xdlg.querySelector("form")!;
  const xq = <T extends HTMLElement = HTMLElement>(s: string) => xdlg.querySelector<T>(s)!;
  const size = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} ГБ` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`);
  let xmode: "export" | "import" = "export";
  let xpath = "";
  const drawParts = (parts: Part[]) => {
    xq(".xfer-parts").innerHTML = parts.map((p) => `<label class="check xfer-part"><input type="checkbox" name="part" value="${esc(p.id)}" ${p.default && p.files ? "checked" : ""} ${p.files ? "" : "disabled"} />
      <span>${esc(t(p.label))} <span class="muted">${p.files ? `${p.files} ${t("файл.")} · ${size(p.bytes)}` : t("пусто")}</span>${p.warn ? `<br><span class="warn small">⚠ ${esc(t(p.warn))}</span>` : ""}</span></label>`).join("");
    const sync = () => { xq(".xfer-notes").hidden = xmode !== "import" || !xq<HTMLInputElement>("input[value=notes]")?.checked; };
    xq(".xfer-parts").onchange = sync;
    sync();
  };
  const chosenParts = () => [...xdlg.querySelectorAll<HTMLInputElement>("input[name=part]:checked")].map((i) => i.value);
  const uiState = () => {
    const out: Record<string, string> = {};
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; if (k.startsWith("opsdeck.")) out[k] = localStorage.getItem(k) ?? ""; } } catch { /* ignore */ }
    return JSON.stringify(out);
  };
  root.querySelector<HTMLElement>("[data-x=export]")!.onclick = async () => {
    xmode = "export";
    xq(".xfer-title").textContent = t("Экспорт настроек");
    xq(".xfer-from").textContent = "";
    xq(".xfer-hint").textContent = t("Отметьте, что перенести. Архив собирается в несколько потоков — большая папка заметок не проблема.");
    xq(".xfer-go").textContent = t("Сохранить архив…");
    xq(".xfer-err").textContent = "";
    xq(".xfer-parts").innerHTML = `<p class="muted">${esc(t("считаю…"))}</p>`;
    xdlg.showModal();
    drawParts(await invoke<Part[]>("transfer_parts").catch((e) => { xq(".xfer-err").textContent = String(e); return []; }));
  };
  root.querySelector<HTMLElement>("[data-x=import]")!.onclick = async () => {
    const path = await invoke<string | null>("transfer_pick").catch(() => null);
    if (!path) return;
    try {
      const r = await invoke<{ manifest: { app_version: string; created: string; os: string; parts: Part[]; notes_root: string }; notes_here: string }>("transfer_inspect", { path });
      xmode = "import";
      xpath = path;
      xq(".xfer-title").textContent = t("Импорт настроек");
      xq(".xfer-from").textContent = `${path} · OpsDeck ${r.manifest.app_version} · ${r.manifest.os} · ${new Date(r.manifest.created).toLocaleString(locale())}`;
      xq(".xfer-hint").textContent = t("Файлы, которые будут заменены, сначала копируются в папку backup-… в настройках OpsDeck. После импорта OpsDeck перезапустится.");
      xq(".xfer-go").textContent = t("Импортировать");
      xq(".xfer-err").textContent = "";
      xq<HTMLInputElement>("input[name=notes_dest]").value = r.notes_here || r.manifest.notes_root;
      xdlg.showModal();
      drawParts(r.manifest.parts.map((p) => ({ ...p, default: p.default })));
    } catch (e) { toast(t(String(e)), "err"); }
  };
  xform.addEventListener("submit", async (e) => {
    if ((e.submitter as HTMLButtonElement | null)?.value !== "go") return;
    e.preventDefault();
    const parts = chosenParts();
    if (!parts.length) { xq(".xfer-err").textContent = t("Ничего не выбрано"); return; }
    const go = xq<HTMLButtonElement>(".xfer-go");
    go.disabled = true;
    try {
      if (xmode === "export") {
        const r = await invoke<{ file: string; files: number; bytes: number } | null>("transfer_export", { parts, ui: uiState(), dest: null });
        if (r) { xdlg.close(); toast(`${t("Сохранено")}: ${r.file} · ${r.files} ${t("файл.")} · ${size(r.bytes)}`); }
      } else {
        const notesDest = xq<HTMLInputElement>("input[name=notes_dest]").value.trim() || null;
        const r = await invoke<{ files: number; backup: string; ui: string | null }>("transfer_import", { path: xpath, parts, notesDest });
        if (r.ui) {
          try { for (const [k, v] of Object.entries(JSON.parse(r.ui) as Record<string, string>)) if (k.startsWith("opsdeck.")) localStorage.setItem(k, v); } catch { /* ignore */ }
        }
        xdlg.close();
        const restart = await ask(t("Импорт завершён"), `${t("Восстановлено файлов")}: ${r.files}.${r.backup ? ` ${t("Прежние версии")}: ${r.backup}.` : ""} ${t("Пароли введите заново: они хранятся в системном хранилище и в архив не попадают.")}`, { ok: t("Перезапустить OpsDeck") });
        if (restart !== null) invoke("app_restart").catch(() => location.reload());
        else toast(t("Настройки применятся после перезапуска OpsDeck"));
      }
    } catch (err) { xq(".xfer-err").textContent = t(String(err)); }
    finally { go.disabled = false; }
  });

  window.addEventListener("view-shown", (e) => { if ((e as CustomEvent).detail === "settings") load(); });
}
