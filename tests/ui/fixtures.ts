import { test as base, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

export type Call = { cmd: string; args: Record<string, unknown> };
const ALL = ["terminal", "k8s", "web", "alerts", "net", "ssh", "code", "db", "notes", "tasks", "vault", "winbox"];

/** Options for the fake backend, set per test with `test.use({ demo: {...} })`. */
export type Demo = { lang?: "ru" | "en"; modules?: string[] | null; overrides?: Record<string, unknown> };

export const test = base.extend<{ demo: Demo; app: App }>({
  demo: [{}, { option: true }],
  // auto: every test gets the app with the fake backend, even if it only asks for `page`
  app: [async ({ page, demo }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => { errors.push(e.message); console.log("pageerror:", e.message, e.stack?.split("\n")[1] ?? ""); });
    page.on("console", (m) => { if (m.type() === "error") console.log("console.error:", m.text()); });
    await page.addInitScript(({ lang, modules, overrides }) => {
      (window as any).__DEMO_LANG = lang;
      (window as any).__DEMO_OVERRIDES = overrides;
      try {
        localStorage.clear();
        if (modules) localStorage.setItem("opsdeck.modules", JSON.stringify(modules));
      } catch { /* ignore */ }
    }, { lang: demo.lang ?? "ru", modules: demo.modules === undefined ? ALL : demo.modules, overrides: demo.overrides ?? {} });
    await page.addInitScript({ path: fileURLToPath(new URL("./mock.js", import.meta.url)) });
    await page.goto("/");
    await expect(page.locator("#sidebar button[data-view]:visible").first()).toBeVisible();
    const app = new App(page);
    await use(app);
    expect(errors, "uncaught errors in the page").toEqual([]);
  }, { auto: true }],
});
export { expect };

export class App {
  constructor(readonly page: Page) {}
  /** Open a section by its sidebar button. */
  async view(id: string) {
    await this.page.click(`#sidebar button[data-view="${id}"]`);
    await expect(this.page.locator(`#sidebar button[data-view="${id}"]`)).toHaveClass(/active/);
  }
  /** Backend calls made so far (optionally only one command). */
  async calls(cmd?: string): Promise<Call[]> {
    const all: Call[] = await this.page.evaluate(() => (window as any).__calls);
    return cmd ? all.filter((c) => c.cmd === cmd) : all;
  }
  /** Wait until the frontend has called `cmd` (and return the last such call). */
  async called(cmd: string, timeout = 5000): Promise<Call> {
    await expect.poll(async () => (await this.calls(cmd)).length, { timeout, message: `${cmd} was not called` }).toBeGreaterThan(0);
    return (await this.calls(cmd)).at(-1)!;
  }
  /** Make the fake backend answer `cmd` with `value` from now on. */
  async override(cmd: string, value: unknown) {
    await this.page.evaluate(([c, v]) => { (window as any).__DEMO_OVERRIDES[c] = v; }, [cmd, value] as const);
  }
  async emit(event: string, payload: unknown) {
    await this.page.evaluate(([e, p]) => (window as any).__demoEmit(e, p), [event, payload] as const);
  }
  /** Text currently shown in the active terminal (xterm DOM renderer rows). */
  terminalText() {
    return this.page.locator(".term-host:not([hidden]) .xterm-rows").first();
  }
}
