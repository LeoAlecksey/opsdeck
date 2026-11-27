import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { marked } from "marked";

const pages = [
  ["module-terminal","Терминал и AI"],
  ["module-k8s","Kubernetes"],
  ["module-web","Веб-панели"],
  ["module-alerts","Алерты"],
  ["module-net","Сеть и DNS"],
  ["module-yc","Yandex Cloud"],
  ["module-sftp","Файлы на хостах"],
  ["module-monitor","Мониторинг хостов"],
  ["module-ssh","SSH"],
  ["module-code","IDE: код и git"],
  ["module-db","Базы данных"],
  ["module-notes","Заметки"],
  ["module-tasks","Задачи и напоминания"],
  ["module-vault","KeePass"],
  ["module-gopass","gopass"],
  ["module-passbolt","Passbolt"],
  ["module-agent","ИИ-агент"],
  ["module-winbox","MikroTik"],
  ["module-settings","Настройки"],
  ["reference","Установка, сборка и технический справочник"],
  ["README", "Главная"],
  ["getting-started", "Установка и первый запуск"],
  ["connections", "Подключения"],
  ["usage", "Использование"],
  ["ai", "Локальный ИИ и OpenCode"],
];
const shots = {
  "С чего начать": ["modules", "Включение модулей OpsDeck"],
  "SSH-хосты": ["ssh", "Список SSH-хостов"],
  "Kubernetes": ["k8s", "Ресурсы кластера Kubernetes"],
  "Веб-панели и алерты": ["alerts", "Алерты в OpsDeck"],
  "Базы данных": ["db", "Структура базы и результаты запросов"],
  "Хранилища паролей": ["vault", "Записи KeePass"],
  "Yandex Cloud и MikroTik": ["yc", "Машины Yandex Cloud"],
  "Терминал": ["terminal", "Терминал OpsDeck"],
  "AI": ["ai-chat", "Чат AI рядом с терминалом"],
  "Файлы, IDE и мониторинг": ["code", "Редактор и панель git"],
  "Заметки и задачи": ["notes", "Заметки и задачи"],
  "Настройки и перенос": ["settings-ai", "Настройки OpsDeck"],
  "Встроенная модель OpsDeck": ["settings-ai", "Выбор локальной модели OpsDeck"],
  "OpenCode с Ollama через JSON": ["ai-chat", "AI-панель OpsDeck"],
};
const esc = s => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
mkdirSync("site/wiki", { recursive: true });
for (const [name, label] of pages) {
  const source = readFileSync(`docs/wiki/${name}.md`, "utf8")
    .replaceAll(/\]\(README\.md\)/g, "](index.html)")
    .replaceAll(/\]\(getting-started\.md\)/g, "](getting-started.html)")
    .replaceAll(/\]\(connections\.md\)/g, "](connections.html)")
    .replaceAll(/\]\(usage\.md\)/g, "](usage.html)")
    .replaceAll(/\]\(ai\.md\)/g, "](ai.html)")
    .replaceAll(/\]\(\.\.\/\.\.\/README\.md([^)]*)\)/g, "](https://github.com/LeoAlecksey/opsdeck/blob/master/README.md$1)");
  let html = marked.parse(source.replace(/\]\((module-[a-z0-9]+|reference)\.md\)/g, "]($1.html)"), { gfm: true });
  for (const [heading, [image, alt]] of Object.entries(shots)) {
    const headingHtml = `<h2>${heading}</h2>`;
    if (html.includes(headingHtml)) html = html.replace(headingHtml, `${headingHtml}\n<figure><a href="../img/ru/${image}.jpg" target="_blank" rel="noopener"><img src="../img/ru/${image}.jpg" alt="${esc(alt)}" loading="lazy" width="2160" height="1350"></a><figcaption>${esc(alt)} · нажмите для увеличения</figcaption></figure>`);
  }
  const nav = pages.map(([id, title]) => `<a ${id === name ? 'aria-current="page"' : ""} href="${id === "README" ? "index" : id}.html">${esc(title)}</a>`).join("\n");
  const output = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(label)} — Wiki OpsDeck</title><meta name="description" content="Руководство OpsDeck: ${esc(label.toLowerCase())}, подключения и работа с программой.">
<link rel="canonical" href="https://leoalecksey.github.io/opsdeck/wiki/${name === "README" ? "index.html" : `${name}.html`}">
<link rel="icon" href="../assets/icon.png"><link rel="stylesheet" href="style.css"></head>
<body><header><a class="brand" href="../"><img src="../assets/icon.png" alt="">OpsDeck</a><a href="index.html">Wiki</a><a class="site-link" href="../">Сайт проекта ↗</a></header>
<div class="layout"><aside><div class="aside-title">Руководство</div><nav>${nav}</nav><div class="aside-foot">Версия dev<br><a href="https://github.com/LeoAlecksey/opsdeck/issues">Сообщить о проблеме ↗</a></div></aside>
<main>${html}</main></div></body></html>`;
  writeFileSync(`site/wiki/${name === "README" ? "index" : name}.html`, output);
}
