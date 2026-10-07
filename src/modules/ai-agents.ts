/**
 * AI agents of the terminal's side panel and the one chosen by default (Settings → AI agent).
 * The choice is shared: the panel's own selector, the palette and Settings all change it.
 */
export type AiProvider = { program: string; args?: string[] };

export const AI_PROVIDERS: Record<string, AiProvider> = {
  "Claude Code": { program: "claude" },
  Codex: { program: "codex" },
  Gemini: { program: "gemini" },
  Aider: { program: "aider" },
  OpenCode: { program: "opencode" },
};

const KEY = "opsdeck.ai.provider";
export const DEFAULT_AGENT = "Claude Code";

export function aiAgent(): string {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && AI_PROVIDERS[saved]) return saved;
  } catch { /* ignore */ }
  return DEFAULT_AGENT;
}

export function setAiAgent(name: string) {
  if (!AI_PROVIDERS[name] || name === aiAgent()) return;
  try { localStorage.setItem(KEY, name); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("ai-agent", { detail: name }));
}

/** "@/path/note.md" or "@/path/note.md#L3-L7": a file reference every agent understands in its prompt. */
export function fileRef(path: string, lineStart: number | null, lineEnd: number | null): string {
  return lineStart !== null && lineEnd !== null ? `@${path}#L${lineStart}-L${lineEnd}` : `@${path}`;
}
