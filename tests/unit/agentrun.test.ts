import { describe, expect, it, vi } from "vitest";
import { hostKey, investigate, parseStep, resultForModel, type Check, type Event, type Run } from "../../src/modules/agentrun";

const HOSTS = [{ key: "id:h1", name: "prod-api" }, { key: "alias:ai", name: "ai" }];
const run = (over: Partial<Run> = {}): Run => ({ command: "df -h", target: "alias:ai", exit_code: 0, output: "/dev/sda1 40G", truncated: false, took_ms: 120, ...over });
const read: Check = { verdict: { kind: "read" }, allowed_now: true, needs_approval: false, why: "" };
const ask: Check = { verdict: { kind: "write" }, allowed_now: false, needs_approval: true, why: "нужно разрешение администратора" };
const forbidden: Check = { verdict: { kind: "forbidden", reason: "«rm» не выполняется даже с разрешения" }, allowed_now: false, needs_approval: false, why: "" };

function io(answers: string[], over: Partial<Parameters<typeof investigate>[1]> = {}) {
  const events: Event[] = [];
  const execs: { target: string; command: string; approved: boolean }[] = [];
  const seen: { role: string; content: string }[][] = [];
  return {
    events, execs, seen,
    opts: {
      ask: vi.fn(async (messages) => { seen.push(messages.map((m) => ({ ...m }))); return answers.shift() ?? "ГОТОВО: всё"; }),
      check: vi.fn(async () => read),
      exec: vi.fn(async (target: string, command: string, approved: boolean) => { execs.push({ target, command, approved }); return run({ command, target }); }),
      confirm: vi.fn(async () => true),
      on: (e: Event) => events.push(e),
      hosts: HOSTS,
      maxSteps: 5,
      ...over,
    },
  };
}

describe("разбор ответа модели", () => {
  it("две строки — это шаг, «ГОТОВО» — конец", () => {
    expect(parseStep("ХОСТ: ai\nКОМАНДА: lsblk -f")).toEqual({ kind: "run", host: "ai", command: "lsblk -f" });
    expect(parseStep("HOST: prod-api\nCMD: journalctl -u api -n 50")).toMatchObject({ host: "prod-api", command: "journalctl -u api -n 50" });
    expect(parseStep("ГОТОВО: диск забит логами")).toEqual({ kind: "done", text: "диск забит логами" });
    // markdown и размышления вокруг не мешают
    expect(parseStep("<think>подумаю</think>```\nХОСТ: ai\nКОМАНДА: df -h\n```")).toMatchObject({ kind: "run", command: "df -h" });
    expect(parseStep("не знаю, что делать")).toMatchObject({ kind: "unclear" });
  });

  it("имя хоста превращается в ключ, которым его знает бэкенд", () => {
    expect(hostKey("prod-api", HOSTS)).toBe("id:h1");
    expect(hostKey("эта машина", HOSTS)).toBe("local");
    expect(hostKey("local", HOSTS)).toBe("local");
    expect(hostKey("ai", HOSTS)).toBe("alias:ai");
    expect(hostKey("которого нет", HOSTS)).toBeNull();
  });
});

describe("цикл расследования", () => {
  it("выполняет команду и возвращает её вывод модели следующим шагом", async () => {
    const { opts, execs, seen, events } = io(["ХОСТ: ai\nКОМАНДА: lsblk -f", "ГОТОВО: lvm лежит на /dev/sda2"]);
    await investigate("что на lvm за директории", opts);
    expect(execs).toEqual([{ target: "alias:ai", command: "lsblk -f", approved: false }]);
    // модель увидела вывод своей же команды
    expect(seen[1].at(-1)!.content).toContain("Вывод (alias:ai, код 0)");
    expect(events.at(-1)).toEqual({ type: "done", text: "lvm лежит на /dev/sda2" });
  });

  it("изменяющую команду не выполняет без разрешения администратора", async () => {
    const { opts, execs, events } = io(["ХОСТ: ai\nКОМАНДА: systemctl restart api", "ГОТОВО: ладно"], { check: async () => ask, confirm: async () => false });
    await investigate("перезапусти api", opts);
    expect(execs).toEqual([]);
    expect(events.some((e) => e.type === "denied" && e.why.includes("не разрешил"))).toBe(true);
  });

  it("с разрешения — выполняет, и это видно в вызове", async () => {
    const { opts, execs } = io(["ХОСТ: ai\nКОМАНДА: systemctl restart api", "ГОТОВО: перезапустил"], { check: async () => ask, confirm: async () => true });
    await investigate("перезапусти api", opts);
    expect(execs).toEqual([{ target: "alias:ai", command: "systemctl restart api", approved: true }]);
  });

  it("запрещённое не выполняется, а отказ уходит модели как результат шага", async () => {
    const { opts, execs, seen, events } = io(["ХОСТ: ai\nКОМАНДА: rm -rf /var/log", "ГОТОВО: понял"], { check: async () => forbidden });
    await investigate("почисти логи", opts);
    expect(execs).toEqual([]);
    expect(events.some((e) => e.type === "step" && e.state === "denied")).toBe(true);
    expect(seen[1].at(-1)!.content).toContain("не выполнена");
  });

  it("несуществующий хост не выполняется нигде — это не повод взять первый попавшийся", async () => {
    const { opts, execs, seen } = io(["ХОСТ: чужой-сервер\nКОМАНДА: df -h", "ГОТОВО: ладно"]);
    await investigate("проверь диск", opts);
    expect(execs).toEqual([]);
    expect(seen[1].at(-1)!.content).toContain("нет в списке");
  });

  it("шаги кончились — останавливаемся сами", async () => {
    const { opts, events, execs } = io(["ХОСТ: ai\nКОМАНДА: df -h", "ХОСТ: ai\nКОМАНДА: free -m", "ХОСТ: ai\nКОМАНДА: uptime"], { maxSteps: 2 });
    await investigate("посмотри всё", opts);
    expect(execs).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: "stopped", why: "шаги кончились" });
  });

  it("кнопка «стоп» прерывает цикл до следующей команды", async () => {
    let stop = false;
    const { opts, execs, events } = io(["ХОСТ: ai\nКОМАНДА: df -h", "ХОСТ: ai\nКОМАНДА: free -m"], {
      exec: async (target: string, command: string) => { stop = true; return run({ command, target }); },
      stopped: () => stop,
    });
    await investigate("посмотри диск", opts);
    expect(execs).toHaveLength(0); // наш exec подменён, важен сам факт остановки
    expect(events.at(-1)).toMatchObject({ type: "stopped" });
  });

  it("вывод для модели помечен хостом и кодом возврата", () => {
    expect(resultForModel(run({ exit_code: 2, output: "", truncated: true }))).toBe("Вывод (alias:ai, код 2, обрезан):\n(пусто)");
  });
});
