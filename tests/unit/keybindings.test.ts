import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bindingFor, bindings, changedBinding, matchShortcut, resetBindings, setBinding } from "../../src/modules/keybindings";
import { macNav } from "../../src/modules/mackeys";

beforeEach(() => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v), removeItem: (k: string) => saved.delete(k) });
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());

it("clears an assignment, frees it for another action, and resets defaults separately", () => {
  setBinding("view.1", null);
  expect(bindingFor("view.1")).toBe("");
  expect(changedBinding("Ctrl+Shift+Digit1", "view.2")).toBeNull();
  setBinding("view.2", "Ctrl+Shift+Digit1");
  expect(bindingFor("view.2")).toBe("Ctrl+Shift+Digit1");
  resetBindings();
  expect(bindingFor("view.1")).toBe("Ctrl+Shift+Digit1");
  expect(bindingFor("view.2")).toBe("Ctrl+Shift+Digit2");
});

it("matches physical keys and exact modifiers after reassignment", () => {
  setBinding("k8s.logs", "Ctrl+Alt+KeyO");
  const e = { code: "KeyO", key: "щ", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false } as KeyboardEvent;
  expect(matchShortcut(e, "k8s.logs")).toBe(true);
  expect(matchShortcut({ ...e, shiftKey: true }, "k8s.logs")).toBe(false);
  expect(changedBinding("Ctrl+Alt+KeyO", "k8s.pod-shell")).not.toBeNull();
});

it("uses the configured macOS terminal action and can disable it", () => {
  setBinding("terminal.line-start", "Meta+KeyH");
  const e = { code: "KeyH", key: "р", ctrlKey: false, altKey: false, shiftKey: false, metaKey: true };
  expect(macNav(e)?.seq).toBe("\x01");
  expect(macNav({ ...e, code: "ArrowLeft", key: "ArrowLeft" })).toBeNull();
  setBinding("terminal.line-start", null);
  expect(macNav(e)).toBeNull();
});

it("ignores malformed saved preferences", () => {
  for (const value of ["null", "[]", "42", "broken", '{"view.1":42}']) {
    localStorage.setItem("opsdeck.keybindings", value);
    expect(bindings()).toEqual({});
    expect(bindingFor("view.1")).toBe("Ctrl+Shift+Digit1");
  }
});
