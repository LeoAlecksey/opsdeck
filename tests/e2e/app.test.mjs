// End-to-end tests of the real app (real backend, real shell) through tauri-driver.
// CI: build with `npx tauri build --debug --no-bundle`, start `tauri-driver` (port 4444), then
//   OPSDECK_BIN=src-tauri/target/debug/opsdeck node --test tests/e2e/app.test.mjs
// Linux needs WebKitWebDriver (package webkit2gtk-driver) and a display (xvfb-run);
// Windows needs msedgedriver matching the WebView2 version. macOS has no WebDriver for WKWebView.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { remote } from "webdriverio";

const BIN = process.env.OPSDECK_BIN;
const WIN = process.platform === "win32";
const ENTER = "";
let b;

/** Poll until fn() is truthy (or fail after `ms`). */
async function until(fn, what, ms = 20_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what} (last: ${last})`);
}
const view = (id) => b.$(`#sidebar button[data-view="${id}"]`);
const termText = () => b.execute(() => [...document.querySelectorAll(".term-host:not([hidden]) .xterm-rows")].map((e) => e.textContent).join("\n"));
const typeInTerminal = async (text) => {
  await (await b.$(".term-host:not([hidden]) .xterm")).click();
  await b.keys([...text, ENTER]);
};

before(async () => {
  assert.ok(BIN, "set OPSDECK_BIN to the built app");
  b = await remote({
    hostname: "127.0.0.1",
    port: 4444,
    logLevel: "warn",
    capabilities: { "tauri:options": { application: BIN } },
  });
  await until(async () => (await view("terminal")).isDisplayed(), "the sidebar");
});

after(async () => { await b?.deleteSession(); });

describe("OpsDeck (real app)", () => {
  it("a fresh install shows the basic modules", async () => {
    const shown = await b.execute(() => [...document.querySelectorAll("#sidebar button[data-view]")].filter((x) => !x.hidden).map((x) => x.dataset.view).sort());
    assert.deepEqual(shown, ["k8s", "notes", "settings", "ssh", "terminal", "vault"]);
  });

  it("the terminal runs a real shell", async () => {
    await (await view("terminal")).click();
    await until(async () => (await termText()).trim().length > 0, "a shell prompt", 30_000);
    // arithmetic proves the shell evaluated the command (an echo of the typed text would not)
    await typeInTerminal(WIN ? '"opsdeck-" + (40+2)' : "echo opsdeck-$((40+2))");
    await until(async () => (await termText()).includes("opsdeck-42"), "the command output");
    const text = await termText();
    assert.ok(!/ParserError|CategoryInfo|is not recognized|command not found/i.test(text), `shell integration errors:\n${text}`);
  });

  it("suggests the rest of a command typed before (shell integration works)", async () => {
    const typed = WIN ? '"opsdeck-" + (40' : "echo opsdeck-$((4";
    await (await b.$(".term-host:not([hidden]) .xterm")).click();
    await b.keys([...typed]);
    // grey inline suggestion after the cursor: needs the OSC 133 marks of the shell integration
    await until(async () => b.execute(() => [...document.querySelectorAll(".term-ghost")].map((e) => e.textContent).join("")), "an inline suggestion", 10_000)
      .then((ghost) => assert.ok(ghost.startsWith(WIN ? "+2)" : "0+2))"), `suggestion: ${ghost}`));
    await b.keys(["Control", "c"]);
    await b.keys(["Control"]);
  });

  it("exit in a second tab closes it", async () => {
    const tabs = () => b.execute(() => document.querySelectorAll(".tabs .tab").length);
    const before = await tabs();
    await (await b.$("[data-act=new]")).click();
    await until(async () => (await tabs()) === before + 1, "a new tab");
    await until(async () => (await termText()).trim().length > 0, "the new shell prompt", 30_000);
    await typeInTerminal("exit");
    await until(async () => (await tabs()) === before, "the tab to close after exit", 15_000);
  });

  it("modules can be turned on: network tools ping localhost", async () => {
    await (await b.$(".modules-btn")).click();
    await (await b.$('.modules-pop input[data-mod="net"]')).click();
    await b.keys(["Escape"]);
    await (await view("net")).click();
    await (await b.$("[data-pane=tools] input[name=target]")).setValue("127.0.0.1");
    const count = await b.$("[data-pane=tools] input[name=count]");
    await count.clearValue();
    await count.setValue("1");
    await (await b.$("[data-pane=tools] button[type=submit]")).click();
    const out = () => b.execute(() => document.querySelector("[data-pane=tools] .output")?.textContent ?? "");
    await until(async () => /127\.0\.0\.1/.test((await out()).split("\n").slice(1).join("\n")), "ping output", 30_000);
    // OEM output decoded on Windows: no replacement characters
    assert.ok(!(await out()).includes("�"), await out());
  });

  it("settings show this version", async () => {
    await (await view("settings")).click();
    const version = (await import("../../package.json", { with: { type: "json" } })).default.version;
    await until(async () => (await b.execute(() => document.querySelector("section.view:not([hidden])")?.textContent ?? "")).includes(version), `version ${version} in Settings`);
  });
});
