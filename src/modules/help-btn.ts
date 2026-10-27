import { toast } from "./ui";

// The guides themselves (help.ts, ~170 KB of text in two languages) load on the first click:
// every section header imports this button, so a static import of help.ts would put them all
// into the startup chunk.

/** "!" button for a section header; opens that section's guide. */
export const helpBtn = (id: string) => `<button type="button" class="help-btn" data-help="${id}" title="Как это работает и что где нажимать">!</button>`;

document.addEventListener("click", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>("[data-help]")?.dataset.help;
  if (!id) return;
  import("./help").then(
    (m) => m.show(id),
    (err) => toast(`Не удалось открыть справку: ${err}`, "err"),
  );
});
