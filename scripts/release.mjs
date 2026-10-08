#!/usr/bin/env node
// Выпуск новой версии в два шага (в master пускают только через PR):
//   1. на ветке dev:    npm run release -- 0.6.2
//      поднимает версию в package.json, tauri.conf.json, Cargo.toml и Cargo.lock, коммитит и пушит dev;
//      дальше PR dev → master, проверки, вливание;
//   2. на ветке master: npm run release -- 0.6.2 @docs/releases/0.6.2.md
//      ставит аннотированный тег v<версия> с описанием и пушит его — GitHub Actions соберёт и опубликует.
// Описание — строкой или из файла (@путь); оно станет текстом релиза и окна обновления.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [version, ...notesParts] = process.argv.slice(2);
const arg = notesParts.join(" ").trim();
const notes = arg.startsWith("@") ? readFileSync(arg.slice(1), "utf8").trim() : arg;
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error('Использование: npm run release -- 0.2.0 "что нового"');
  process.exit(1);
}
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
if (git("status", "--porcelain")) {
  console.error("Есть незакоммиченные изменения — закоммитьте или уберите их перед релизом.");
  process.exit(1);
}
if (git("tag", "-l", `v${version}`)) {
  console.error(`Тег v${version} уже существует.`);
  process.exit(1);
}

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const current = JSON.parse(readFileSync("package.json", "utf8")).version;
if (branch === "master" || branch === "main") {
  if (current !== version) {
    console.error(`В ${branch} версия ${current}, а не ${version}. Сначала на dev: npm run release -- ${version}, затем PR dev → ${branch}.`);
    process.exit(1);
  }
  // verbatim: otherwise git drops lines starting with # (markdown headings)
  git("tag", "-a", "--cleanup=verbatim", `v${version}`, "-m", notes || `OpsDeck v${version}`);
  git("push", "origin", `v${version}`);
  console.log(`✓ v${version} отправлена. Сборка и публикация релиза: GitHub → Actions.`);
  process.exit(0);
}

const edit = (file, fn) => writeFileSync(file, fn(readFileSync(file, "utf8")));
edit("package.json", (s) => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
edit("src-tauri/tauri.conf.json", (s) => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
edit("src-tauri/Cargo.toml", (s) => s.replace(/^version = "[^"]+"/m, `version = "${version}"`));
edit("src-tauri/Cargo.lock", (s) => s.replace(/(name = "opsdeck"\nversion = )"[^"]+"/, `$1"${version}"`));

git("add", "package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock");
// the version may already be set (e.g. the very first release): commit only if something changed
if (git("status", "--porcelain")) git("commit", "-m", `Release v${version}`);
git("push");
console.log(`✓ версия ${version} в ${branch}. Дальше: PR ${branch} → master, после вливания на master — npm run release -- ${version} @docs/releases/${version}.md`);
