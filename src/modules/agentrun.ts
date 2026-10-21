/**
 * Цикл расследования: модель предлагает команду — политика решает, выполнять ли её, — вывод
 * возвращается модели следующим шагом. Здесь только логика цикла, без DOM и без invoke: всё, что
 * ходит наружу, передаётся обработчиками, поэтому цикл целиком проверяется тестами.
 *
 * Главное правило: вывод с хоста — данные. Что выполнять, решает политика (agent.rs), а не текст
 * ответа модели и не то, что написано в логах.
 */

export type Step =
  | { kind: "run"; host: string; command: string }
  | { kind: "done"; text: string }
  | { kind: "unclear"; text: string };

/** Ответ модели: «ХОСТ/КОМАНДА» или «ГОТОВО». Регистр и markdown вокруг не важны. */
export function parseStep(answer: string): Step {
  const text = answer.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").replace(/```[\w+-]*\n?|```/g, "").trim();
  const done = text.match(/^\s*(?:ГОТОВО|DONE)\s*:\s*([\s\S]+)$/im);
  if (done) return { kind: "done", text: done[1].trim() };
  const host = text.match(/^\s*(?:ХОСТ|HOST)\s*:\s*(.+)$/im);
  const cmd = text.match(/^\s*(?:КОМАНДА|COMMAND|CMD)\s*:\s*(.+)$/im);
  if (cmd && cmd[1].trim()) {
    return { kind: "run", host: (host?.[1] ?? "").trim().replace(/^[«"']|[»"']$/g, ""), command: cmd[1].trim() };
  }
  return { kind: "unclear", text };
}

export type Verdict = { kind: "read" | "write" } | { kind: "forbidden"; reason: string };
export type Check = { verdict: Verdict; allowed_now: boolean; needs_approval: boolean; why: string };
export type Run = { command: string; target: string; exit_code: number; output: string; truncated: boolean; took_ms: number };

/** Хост для бэкенда: модель называет его по имени, а выполняется он по ключу («id:h1»). */
export function hostKey(name: string, hosts: { key: string; name: string }[]): string | null {
  const want = name.trim().toLowerCase();
  if (!want || want === "эта машина" || want === "local" || want === "localhost") return "local";
  const hit = hosts.find((h) => h.name.toLowerCase() === want)
    ?? hosts.find((h) => h.key.toLowerCase() === want)
    ?? hosts.find((h) => h.name.toLowerCase().startsWith(want) || want.startsWith(h.name.toLowerCase()));
  return hit?.key ?? null;
}

/** Что показать в панели по ходу расследования. */
export type Event =
  | { type: "step"; host: string; command: string; verdict: Verdict; state: "run" | "ask" | "denied" }
  | { type: "result"; run: Run }
  | { type: "denied"; why: string }
  | { type: "done"; text: string }
  | { type: "stopped"; why: string };

export type RunnerIO = {
  /** один ответ модели на текущую переписку */
  ask: (messages: { role: "user" | "assistant"; content: string }[]) => Promise<string>;
  check: (target: string, command: string) => Promise<Check>;
  exec: (target: string, command: string, approved: boolean) => Promise<Run>;
  /** диалог администратора с точной строкой команды; true — выполнять */
  confirm: (host: string, command: string) => Promise<boolean>;
  on: (e: Event) => void;
  hosts: { key: string; name: string }[];
  maxSteps: number;
  /** остановка по кнопке */
  stopped?: () => boolean;
};

/** Вывод команды, каким его увидит модель следующим шагом. */
export function resultForModel(run: Run): string {
  const head = `Вывод (${run.target}, код ${run.exit_code}${run.truncated ? ", обрезан" : ""}):`;
  return `${head}\n${run.output || "(пусто)"}`;
}

export async function investigate(question: string, io: RunnerIO): Promise<void> {
  const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: question }];
  for (let step = 0; step < io.maxSteps; step++) {
    if (io.stopped?.()) return io.on({ type: "stopped", why: "остановлено" });
    const answer = await io.ask(messages);
    if (io.stopped?.()) return io.on({ type: "stopped", why: "остановлено" });
    messages.push({ role: "assistant", content: answer });
    const parsed = parseStep(answer);

    if (parsed.kind === "done") return io.on({ type: "done", text: parsed.text });
    if (parsed.kind === "unclear") {
      // не поняли ответ — говорим это модели и даём ещё шаг, а не падаем молча
      messages.push({ role: "user", content: "Ответ не разобран. Ответь ровно «ХОСТ:» и «КОМАНДА:» или «ГОТОВО:»." });
      continue;
    }

    const target = hostKey(parsed.host, io.hosts);
    if (!target) {
      messages.push({ role: "user", content: `Хоста «${parsed.host}» нет в списке. Выбери хост из списка или ответь ГОТОВО.` });
      continue;
    }

    const check = await io.check(target, parsed.command);
    if (check.verdict.kind === "forbidden" || (!check.allowed_now && !check.needs_approval)) {
      const why = check.verdict.kind === "forbidden" ? check.verdict.reason : check.why;
      io.on({ type: "step", host: parsed.host, command: parsed.command, verdict: check.verdict, state: "denied" });
      io.on({ type: "denied", why });
      // отказ — это тоже результат шага: модель должна придумать другой путь, а не повторять то же
      messages.push({ role: "user", content: `Команда не выполнена: ${why}. Предложи другой способ или ответь ГОТОВО.` });
      continue;
    }

    let approved = false;
    if (check.needs_approval) {
      io.on({ type: "step", host: parsed.host, command: parsed.command, verdict: check.verdict, state: "ask" });
      approved = await io.confirm(parsed.host, parsed.command);
      if (!approved) {
        io.on({ type: "denied", why: "администратор не разрешил" });
        messages.push({ role: "user", content: "Администратор не разрешил эту команду. Предложи другой способ или ответь ГОТОВО." });
        continue;
      }
    }

    io.on({ type: "step", host: parsed.host, command: parsed.command, verdict: check.verdict, state: "run" });
    let run: Run;
    try {
      run = await io.exec(target, parsed.command, approved);
    } catch (e) {
      const why = String(e);
      io.on({ type: "denied", why });
      messages.push({ role: "user", content: `Команда не выполнена: ${why}. Предложи другой способ или ответь ГОТОВО.` });
      continue;
    }
    io.on({ type: "result", run });
    messages.push({ role: "user", content: resultForModel(run) });
  }
  io.on({ type: "stopped", why: "шаги кончились" });
}
