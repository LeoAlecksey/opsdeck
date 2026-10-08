#!/usr/bin/env node
// Guards the author's donation and Telegram links against being swapped in a pull request.
// Fails if any tracked file has a donation/payment link, crypto wallet or Telegram link other
// than the allowed ones, or if the allowed links are missing where they must be.
// Runs in CI (checks job) and on pull requests (security-label workflow).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// the only allowed values
const DONATE = "https://yoomoney.ru/to/4100119645604976";
const TG = "https://t.me/sys_admin_expert";
const ALLOWED_TG = new Set(["sys_admin_expert"]);
const ALLOWED_YOOMONEY = new Set(["4100119645604976"]);

// where they must stay
const REQUIRED = {
  "src/modules/settings.ts": [DONATE, TG],
  "README.md": [DONATE, TG],
  "site/index.html": [DONATE, TG],
  "site/en/index.html": [TG],
};

const SELF = "scripts/check-links.mjs";
const SKIP = /(^|\/)(node_modules|dist|target)\/|package-lock\.json$|Cargo\.lock$|\.(png|jpe?g|gif|ico|icns|woff2?|ttf|gguf|zip|gz)$/i;

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter((f) => f && f !== SELF && !SKIP.test(f));
const problems = [];

const checks = [
  // Telegram: only the author's channel
  { re: /(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_+]+)/gi, ok: (m) => ALLOWED_TG.has(m[1]), what: "ссылка Telegram" },
  // YooMoney: only the author's wallet
  { re: /yoomoney\.ru\/(?:to|quickpay[^\s"'<>)]*receiver=)\/?(\d+)/gi, ok: (m) => ALLOWED_YOOMONEY.has(m[1]), what: "кошелёк ЮMoney" },
  { re: /yoomoney\.ru\/(?!to\/)[^\s"'<>)]+/gi, ok: () => false, what: "ссылка ЮMoney" },
  // other donation / payment services: none are used by the project
  { re: /\b(?:boosty\.to|patreon\.com|donationalerts\.com|buymeacoffee\.com|ko-fi\.com|paypal\.me|paypal\.com\/donate|qiwi\.(?:com|me)|tinkoff\.ru\/(?:cf|rm)|cloudtips\.ru|sbp\.nspk\.ru|opencollective\.com|github\.com\/sponsors)\S*/gi, ok: () => false, what: "ссылка на оплату/донат" },
  // crypto wallets
  { re: /\b(?:bc1[ac-hj-np-z02-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|0x[a-fA-F0-9]{40}|T[1-9A-HJ-NP-Za-km-z]{33}|U[QC][A-Za-z0-9_-]{46})\b/g, ok: () => false, what: "адрес криптокошелька" },
];

for (const f of files) {
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const c of checks) {
      for (const m of line.matchAll(c.re)) {
        // a 0x… hash in a lockfile-like context is not a wallet: only flag it near payment words
        if (c.what === "адрес криптокошелька" && !/wallet|кошел|donat|донат|usdt|eth|btc|ton|send|поддерж/i.test(line)) continue;
        if (!c.ok(m)) problems.push(`${f}:${i + 1}: ${c.what}: ${m[0]}`);
      }
    }
  });
}

for (const [f, needed] of Object.entries(REQUIRED)) {
  let text = "";
  try { text = readFileSync(f, "utf8"); } catch { problems.push(`${f}: файл пропал`); continue; }
  for (const n of needed) if (!text.includes(n)) problems.push(`${f}: нет ссылки автора ${n}`);
}

if (problems.length) {
  console.error("✗ Ссылки на донат/Telegram изменены или добавлены чужие:\n  " + problems.join("\n  "));
  console.error(`\nРазрешены только ${DONATE} и ${TG}. Если меняет автор — поправьте scripts/check-links.mjs.`);
  process.exit(1);
}
console.log(`✓ ссылки на донат и Telegram в порядке (${files.length} файлов)`);
