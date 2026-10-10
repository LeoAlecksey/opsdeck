/** Text for the AI panel built from the IDE: what the model needs to answer about a file or a project. */

/** Cuts `s` at `max` characters, saying so. */
export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… (обрезано: ещё ${s.length - max} символов)`;
}

/** A code block that survives backticks inside the text. */
export function fenced(body: string, lang = ""): string {
  let fence = "```";
  while (body.includes(fence)) fence += "`";
  return `${fence}${lang}\n${body.replace(/\n$/, "")}\n${fence}`;
}

export type ProjectInfo = {
  name: string;
  path: string;
  branch: string;
  /** top-level folder → its entries; "" holds the entries of the root */
  tree: Record<string, string[]>;
  /** git status: file → code */
  changes: Record<string, string>;
};

const MAX_TREE = 40, MAX_CHANGES = 40;

export function projectContext(p: ProjectInfo): string {
  const lines: string[] = [];
  const root = p.tree[""] ?? [];
  for (const e of root.slice(0, MAX_TREE)) {
    lines.push(e);
    for (const k of (p.tree[e.replace(/\/$/, "")] ?? []).slice(0, MAX_TREE)) lines.push(`  ${k}`);
  }
  if (root.length > MAX_TREE) lines.push(`… ещё ${root.length - MAX_TREE}`);
  const ch = Object.entries(p.changes);
  const status = ch.length
    ? ch.slice(0, MAX_CHANGES).map(([f, c]) => `${(c.trim() || "M").padEnd(2)} ${f}`).join("\n") + (ch.length > MAX_CHANGES ? `\n… ещё ${ch.length - MAX_CHANGES}` : "")
    : "чисто";
  return [
    `Проект «${p.name}» (${p.path})${p.branch ? `, ветка ${p.branch}` : ""}.`,
    "Структура:", fenced(lines.join("\n") || "(пусто)"),
    "Изменения git:", fenced(status),
    "Мой вопрос по проекту: ",
  ].join("\n");
}

export function fileContext(path: string, text: string, selection: { from: number; to: number } | null, max = 8000): string {
  const part = selection ? `Фрагмент (строки ${selection.from}–${selection.to}) файла` : "Файл";
  return `${part} ${path}:\n${fenced(clip(text, max))}\nМой вопрос: `;
}

export function diffContext(project: string, diffs: { file: string; diff: string }[], total: number, perFile = 3000): string {
  const body = diffs.map((d) => `# ${d.file}\n${clip(d.diff, perFile)}`).join("\n\n");
  return `Незакоммиченные изменения в ${project}${total > diffs.length ? ` (показаны ${diffs.length} из ${total} файлов)` : ""}:\n${fenced(body || "(нет)", "diff")}\nПроверь изменения и скажи, что не так: `;
}
