import { describe, expect, it } from "vitest";
import { findUrls, siteTarget, throughTunnel } from "../../src/modules/urls";

describe("ссылки в выводе терминала", () => {
  it("находит адрес вместе с хвостом строки, но без знаков препинания", () => {
    const line = "Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...";
    expect(findUrls(line)).toEqual([{ text: "http://0.0.0.0:8000/", start: 35 }]);
    expect(findUrls("  ➜  Local:   http://localhost:5173/").map((u) => u.text)).toEqual(["http://localhost:5173/"]);
    expect(findUrls("см. https://example.com/docs.").map((u) => u.text)).toEqual(["https://example.com/docs"]);
    expect(findUrls("адресов нет")).toEqual([]);
    expect(findUrls("http://")).toEqual([]);
  });

  it("0.0.0.0 — это «слушаю везде», подключаться надо на 127.0.0.1", () => {
    expect(siteTarget("http://0.0.0.0:8000/")).toEqual({ url: "http://127.0.0.1:8000/", port: 8000, here: true });
    expect(siteTarget("http://[::]:8080/app")).toMatchObject({ url: "http://127.0.0.1:8080/app", here: true });
  });

  it("отличает «та же машина» от настоящего хоста", () => {
    expect(siteTarget("http://localhost:5173/")?.here).toBe(true);
    expect(siteTarget("http://127.0.0.5:9000/")?.here).toBe(true);
    expect(siteTarget("https://grafana.example.com/d/abc")?.here).toBe(false);
    // порт по умолчанию берётся из схемы: его же надо пробрасывать
    expect(siteTarget("https://example.com/")?.port).toBe(443);
    expect(siteTarget("http://example.com/")?.port).toBe(80);
    expect(siteTarget("ftp://example.com/")).toBeNull();
  });

  it("через туннель открывается тот же путь на локальном порту", () => {
    expect(throughTunnel("http://0.0.0.0:8000/logs/app.log", 45321)).toBe("http://127.0.0.1:45321/logs/app.log");
  });
});
