import { describe, expect, it } from "vitest";
import { bucketTitle, buckets, levelOf, parseLogLine } from "../../src/modules/loghist";

describe("гистограмма логов (#73)", () => {
  it("метка времени Kubernetes отделяется от текста", () => {
    const p = parseLogLine("2026-10-13T18:04:10.123456789Z GET /health 200");
    expect(p.time).toBe(Date.parse("2026-10-13T18:04:10.123Z"));
    expect(p.text).toBe("GET /health 200");
    expect(p.level).toBe("info");
    // со смещением тоже
    expect(parseLogLine("2026-10-13T21:04:10+03:00 ok").time).toBe(Date.parse("2026-10-13T18:04:10Z"));
    // без метки — строка целиком и без времени
    const no = parseLogLine("просто строка");
    expect(no.time).toBeUndefined();
    expect(no.text).toBe("просто строка");
  });

  it("уровень по слову в строке, ошибка важнее предупреждения", () => {
    expect(levelOf("ERROR connection refused")).toBe("error");
    expect(levelOf('{"level":"error","msg":"x"}')).toBe("error");
    expect(levelOf("[warn] upstream slow")).toBe("warn");
    expect(levelOf("WARNING: deprecated flag")).toBe("warn");
    expect(levelOf("panic: runtime error")).toBe("error");
    expect(levelOf("GET / 200")).toBe("info");
    // слово внутри другого слова уровнем не считается
    expect(levelOf("terrorism in the news")).toBe("info");
    expect(levelOf("warnings_total 5")).toBe("info");
  });

  it("корзины покрывают время от первой до последней строки", () => {
    const at = (s: string, level = "info" as const) => ({ time: Date.parse(s), level });
    const lines = [at("2026-10-13T18:00:00Z"), at("2026-10-13T18:00:30Z", "error" as never), at("2026-10-13T18:01:00Z")];
    const b = buckets(lines, 3);
    expect(b).toHaveLength(3);
    expect(b[0].from).toBe(Date.parse("2026-10-13T18:00:00Z"));
    expect(b[0].info).toBe(1);
    expect(b[1].error).toBe(1);
    expect(b[2].info).toBe(1);
    expect(b.at(-1)!.to).toBeGreaterThanOrEqual(Date.parse("2026-10-13T18:01:00Z"));
    // строки без времени не попадают никуда и не ломают раскладку
    expect(buckets([{ level: "info" }, ...lines], 3).reduce((n, x) => n + x.info + x.error, 0)).toBe(3);
    expect(buckets([], 10)).toEqual([]);
    expect(buckets([{ level: "info" }], 10)).toEqual([]);
  });

  it("всё в одну секунду — одна корзина, а не пустой график", () => {
    const one = Date.parse("2026-10-13T18:00:00Z");
    const b = buckets([{ time: one, level: "info" }, { time: one, level: "error" }], 60);
    expect(b).toHaveLength(1);
    expect([b[0].info, b[0].error]).toEqual([1, 1]);
  });

  it("подпись корзины говорит, сколько и чего", () => {
    const fmt = (ms: number) => new Date(ms).toISOString().slice(11, 19);
    const b = { from: Date.parse("2026-10-13T18:00:00Z"), to: Date.parse("2026-10-13T18:00:09Z") + 999, error: 3, warn: 1, info: 8 };
    expect(bucketTitle(b, fmt)).toBe("18:00:00–18:00:10 · 12, ошибок 3, предупреждений 1");
    expect(bucketTitle({ ...b, error: 0, warn: 0 }, fmt)).toBe("18:00:00–18:00:10 · 8");
  });
});
