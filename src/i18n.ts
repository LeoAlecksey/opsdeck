/**
 * Interface language. The UI is written in Russian; for English, every Russian fragment that
 * appears on screen (text, title, placeholder, toasts, dialogs, backend errors) is looked up in
 * locales/en.json — exact strings first, then patterns with {} placeholders ("Удалить «{}»?").
 * User content (terminals, editors, notes, query results…) is never touched.
 */
import en from "../locales/en.json";
import { buildPatterns, makeTr } from "./i18n-core";

export type Lang = "ru" | "en";
const KEY = "opsdeck.lang";
const CYR = /[А-Яа-яЁё]/;

/** "auto" follows the system locale. */
export function langSetting(): Lang | "auto" {
  try {
    const v = localStorage.getItem(KEY) as Lang | "auto" | null;
    if (v) return v;
    // OpsDeck was already used here (it was Russian-only before): don't switch language on update
    const used = Object.keys(localStorage).some((k) => k.startsWith("opsdeck.") && k !== KEY);
    if (used) {
      localStorage.setItem(KEY, "ru");
      return "ru";
    }
    return "auto";
  } catch { return "auto"; }
}
export function currentLang(): Lang {
  const s = langSetting();
  if (s === "ru" || s === "en") return s;
  return /^ru|^be|^uk|^kk/i.test(navigator.language) ? "ru" : "en";
}
export function setLang(l: Lang | "auto") {
  try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
  location.reload(); // every module renders its markup again in the new language
}

const lang = currentLang();
const dict = en as Record<string, string>;

const pats = buildPatterns(dict);
const translate = makeTr(dict, pats);

/** Translate one fragment (exact, then pattern); unknown text comes back unchanged. */
export function tr(s: string): string {
  return lang === "ru" ? s : translate(s);
}

/** For text built in code and not shown through the DOM (window titles, notifications…). */
export const t = (s: string) => tr(s);
/** Dates and times in the interface language, not the system one. */
export const locale = () => (lang === "en" ? "en-US" : "ru-RU");

// ----- live DOM translation -----

// never translate inside these: terminals, editors, user notes, query results, logs
const SKIP = ".xterm, .cm-editor, .note-editor, .note-view, .db-editor, .db-table-wrap, .db-json, .aa-cmd, .log-view, .upd-notes, .kp-notes, " +
  // user-written texts that could happen to equal an interface word
  ".tk-text, .rc-text, .cal-t, .tk-note, .note-path, .cg-msg, .kp-table td, .al-card .al-title, pre, code, textarea, [data-no-i18n]";
const ATTRS = ["title", "placeholder", "aria-label"];

function skip(el: Element | null): boolean {
  return !!el?.closest(SKIP);
}
// attributes (title, placeholder) are interface even on a textarea or an input; only real content
// areas keep theirs as they are
const SKIP_ATTR = ".xterm, .cm-editor, .note-view, .db-table-wrap, [data-no-i18n]";
const skipAttr = (el: Element) => !!el.closest(SKIP_ATTR);

function translateNode(n: Node) {
  if (n.nodeType === Node.TEXT_NODE) {
    const v = n.nodeValue ?? "";
    if (CYR.test(v) && !skip(n.parentElement)) {
      const out = tr(v);
      if (out !== v) n.nodeValue = out;
    }
    return;
  }
  if (n.nodeType !== Node.ELEMENT_NODE) return;
  const el = n as Element;
  if (!skipAttr(el)) for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v && CYR.test(v)) {
      const out = tr(v);
      if (out !== v) el.setAttribute(a, out);
    }
  }
  if (skip(el)) {
    // textareas/inputs inside: their own attributes are still interface
    el.querySelectorAll?.("[placeholder],[title]").forEach((x) => { if (!skipAttr(x)) translateNode(x); });
    return;
  }
  // buttons with value="…" (rare) are left as they are: their value is data
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (x) => {
      if (x.nodeType !== Node.ELEMENT_NODE || !(x as Element).matches(SKIP)) return NodeFilter.FILTER_ACCEPT;
      // user content keeps its text, but buttons inside it still have interface tooltips
      for (const e of [x as Element, ...(x as Element).querySelectorAll("[title],[placeholder],[aria-label]")]) {
        if (skipAttr(e)) continue;
        for (const a of ATTRS) {
          const v = e.getAttribute(a);
          if (v && CYR.test(v)) { const out = tr(v); if (out !== v) e.setAttribute(a, out); }
        }
      }
      return NodeFilter.FILTER_REJECT;
    },
  });
  let cur = walker.nextNode();
  while (cur) {
    if (cur.nodeType === Node.TEXT_NODE) {
      const v = cur.nodeValue ?? "";
      if (CYR.test(v)) {
        const out = tr(v);
        if (out !== v) cur.nodeValue = out;
      }
    } else {
      const e = cur as Element;
      for (const a of ATTRS) {
        const v = e.getAttribute(a);
        if (v && CYR.test(v)) {
          const out = tr(v);
          if (out !== v) e.setAttribute(a, out);
        }
      }
    }
    cur = walker.nextNode();
  }
}

/** Start translating the page (no-op for Russian). Runs before paint, so nothing flickers. */
export function startI18n() {
  document.documentElement.lang = lang;
  if (lang === "ru") return;
  translateNode(document.body);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "childList") m.addedNodes.forEach(translateNode);
      else if (m.type === "characterData") translateNode(m.target);
      else if (m.type === "attributes" && m.target.nodeType === Node.ELEMENT_NODE) {
        const el = m.target as Element, a = m.attributeName!;
        const v = el.getAttribute(a);
        if (v && CYR.test(v) && !skipAttr(el)) {
          const out = tr(v);
          if (out !== v) el.setAttribute(a, out);
        }
      }
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

/** Dev aid: Russian text on screen that has no translation (call from the devtools console). */
export function untranslated(): string[] {
  const out = new Set<string>();
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n = w.nextNode();
  while (n) {
    const v = (n.nodeValue ?? "").trim();
    if (CYR.test(v) && !skip(n.parentElement)) out.add(v);
    n = w.nextNode();
  }
  return [...out];
}
(window as unknown as { opsdeckUntranslated: typeof untranslated }).opsdeckUntranslated = untranslated;
