import { invoke } from "@tauri-apps/api/core";
import { overlay } from "./ui";

/** Search paths without reading file contents or traversing symlinked directories. */
export function quickOpen(root: string, open: (path: string) => void) {
  const dialog = document.createElement("dialog");
  dialog.className = "code-quick-open";
  const input = document.createElement("input");
  input.placeholder = "Найти файл по имени…";
  input.setAttribute("aria-label", "Найти файл");
  const status = document.createElement("p");
  const list = document.createElement("div");
  dialog.append(input, status, list);
  document.body.append(dialog);
  overlay(true);
  dialog.addEventListener("close", () => { dialog.remove(); overlay(false); });
  dialog.showModal(); input.focus();
  const files: string[] = [];
  let selected = 0;
  let matches: string[] = [];
  function choose(path: string) { dialog.close(); open(`${root.replace(/\/$/, "")}/${path}`); }
  function draw() {
    matches = files.filter((p) => p.toLowerCase().includes(input.value.toLowerCase())).slice(0, 100);
    selected = Math.min(selected, Math.max(0, matches.length - 1));
    list.replaceChildren(...matches.map((path, i) => {
      const button = document.createElement("button");
      button.textContent = path; button.classList.toggle("selected", i === selected);
      button.onclick = () => choose(path);
      return button;
    }));
  }
  input.oninput = () => { selected = 0; draw(); };
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); selected = Math.max(0, Math.min(matches.length - 1, selected + (e.key === "ArrowDown" ? 1 : -1))); draw();
      list.children[selected]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && matches[selected]) { e.preventDefault(); choose(matches[selected]); }
  };
  const skip = new Set([".git", "node_modules", "target", "dist", ".terraform", ".venv", "__pycache__"]);
  void (async () => {
    const dirs = [""];
    let scanned = 0;
    let errors = 0;
    while (dirs.length && dialog.open && files.length < 20000 && scanned++ < 3000) {
      const rel = dirs.pop()!;
      const entries = await invoke<{ name: string; dir: boolean; link: boolean }[]>("fs_list", { path: rel ? `${root}/${rel}` : root, hidden: true }).catch(() => { errors++; return []; });
      if (!dialog.open) return;
      for (const entry of entries) {
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.dir) { if (!entry.link && !skip.has(entry.name)) dirs.push(path); }
        else files.push(path);
      }
      files.sort(); draw(); status.textContent = `Поиск файлов… ${files.length}`;
    }
    status.textContent = `${files.length} файлов${dirs.length ? " (достигнут лимит поиска)" : ""}${errors ? " · часть папок недоступна" : ""}`;
  })();
}
