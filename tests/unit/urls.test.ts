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
    expect(siteTarget("http://0.0.0.0:8000/")).toEqual({ url: "http://127.0.0.1:8000/", host: "127.0.0.1", port: 8000, where: "here" });
    expect(siteTarget("http://[::]:8080/app")).toMatchObject({ url: "http://127.0.0.1:8080/app", where: "here" });
  });

  /// Из отчёта: сервер напечатал своё короткое имя, браузер получил «http://adas-adcu-build-3:8025»
  /// и, разумеется, никуда не попал — такого имени снаружи той сети нет.
  it("короткое имя и частный адрес живут только в сети хоста", () => {
    expect(siteTarget("http://adas-adcu-build-3:8025/")).toMatchObject({ host: "adas-adcu-build-3", port: 8025, where: "inside" });
    expect(siteTarget("http://10.1.2.3:9000/")?.where).toBe("inside");
    expect(siteTarget("http://192.168.1.10/")?.where).toBe("inside");
    expect(siteTarget("http://172.20.0.5:3000/")?.where).toBe("inside");
    expect(siteTarget("http://100.70.0.4:3000/")?.where).toBe("inside");
    // а это уже обычные адреса, их незачем тащить через туннель
    expect(siteTarget("http://172.32.0.5:3000/")?.where).toBe("outside");
    expect(siteTarget("https://build-3.corp.example.com/")?.where).toBe("outside");
  });

  it("отличает «та же машина» от настоящего хоста", () => {
    expect(siteTarget("http://localhost:5173/")?.where).toBe("here");
    expect(siteTarget("http://127.0.0.5:9000/")?.where).toBe("here");
    expect(siteTarget("https://grafana.example.com/d/abc")?.where).toBe("outside");
    // порт по умолчанию берётся из схемы: его же надо пробрасывать
    expect(siteTarget("https://example.com/")?.port).toBe(443);
    expect(siteTarget("http://example.com/")?.port).toBe(80);
    expect(siteTarget("ftp://example.com/")).toBeNull();
  });

  it("через туннель открывается тот же путь на локальном порту", () => {
    expect(throughTunnel("http://0.0.0.0:8000/logs/app.log", 45321)).toBe("http://127.0.0.1:45321/logs/app.log");
  });
});
