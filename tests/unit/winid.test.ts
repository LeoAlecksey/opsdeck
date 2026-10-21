import { describe, expect, it, vi } from "vitest";

/** Метку окна фронтенд читает из метаданных Tauri; для теста подставляем её сами. */
async function load(label?: string) {
  vi.resetModules();
  (globalThis as unknown as { window: unknown }).window = label === undefined
    ? {}
    : { __TAURI_INTERNALS__: { metadata: { currentWindow: { label } } } };
  return import("../../src/modules/winid");
}

describe("идентификаторы сессий в разных окнах", () => {
  it("в главном окне остаются короткими", async () => {
    const { uid, winLabel, popoutView } = await load("main");
    expect(winLabel()).toBe("main");
    expect(popoutView()).toBe("");
    expect(uid("pty")).toBe("pty1");
    expect(uid("pty")).toBe("pty2");
    expect(uid("chat")).toBe("chat3");
  });

  it("в вынесенном окне получают его метку: одно имя сессии в двух окнах — чужие события и затёртая запись в бэкенде", async () => {
    const main = await load("main");
    const pop = await load("pop-terminal");
    expect(pop.popoutView()).toBe("terminal");
    expect(pop.uid("pty")).toBe("pty-pop-terminal-1");
    expect(pop.uid("pty")).not.toBe(main.uid("pty"));
  });

  it("в имя события попадают только разрешённые Tauri символы", async () => {
    const { uid } = await load("pop-../../etc:passwd");
    expect(uid("pty")).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("без метаданных Tauri (браузер, тесты) ведёт себя как главное окно", async () => {
    const { winLabel, popoutView, uid } = await load(undefined);
    expect(winLabel()).toBe("main");
    expect(popoutView()).toBe("");
    expect(uid("run")).toBe("run1");
  });
});
