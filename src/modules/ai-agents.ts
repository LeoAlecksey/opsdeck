export type AiProvider = { program: string; args?: string[] };

export const AI_PROVIDERS: Record<string, AiProvider> = {
  "Claude Code": { program: "claude" },
  OpenCode: { program: "opencode" },
  Codex: { program: "codex" },
  Gemini: { program: "gemini" },
  Aider: { program: "aider" },
};

const STORAGE_KEY = "opsdeck.ai.provider";
const DEFAULT_PROVIDER = "Claude Code";

export function getAiAgent(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && AI_PROVIDERS[saved]) return saved;
  } catch {
    /* ignore */
  }
  return DEFAULT_PROVIDER;
}

export function setAiAgent(name: string) {
  if (!AI_PROVIDERS[name]) return;
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent("ai-agent-changed", { detail: name }));
}
