import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../src/modules/help", () => ({ helpBtn: () => "" }));
vi.mock("../../src/modules/icons", () => ({ icon: () => "" }));
vi.mock("../../src/modules/ui", () => ({ esc: (s: string) => s }));
const m = await import("../../src/modules/monitor");

const stats = (o: Partial<Parameters<typeof m.worst>[0]> = {}) => ({
  host: "h", cpu: 10, cores: 4, load: [0.5, 0.5, 0.5] as [number, number, number], mem_used: 1, mem_total: 10,
  swap_used: 0, swap_total: 0, disk_mount: "/", disk_used: 1, disk_total: 10, uptime: 0, ...o,
});

describe("monitoring board", () => {
  it("colours a host by its worst value", () => {
    expect(m.worst(stats())).toBe("ok");
    expect(m.worst(stats({ disk_used: 8 }))).toBe("warn");
    expect(m.worst(stats({ mem_used: 9.5 }))).toBe("bad");
    expect(m.worst(stats({ load: [3.8, 1, 1] }))).toBe("bad"); // 95% of 4 cores
    expect(m.worst(stats({ cpu: null, mem_total: 0, disk_total: 0 }))).toBe("ok");
  });

  it("formats sizes and uptime", () => {
    expect(m.gb(3e9)).toBe("3.0 GB");
    expect(m.gb(2.5e12)).toBe("2.5 TB");
    expect(m.uptime(90000)).toBe("1д 1ч");
    expect(m.uptime(3700)).toBe("1ч 1м");
    expect(m.pct(1, 0)).toBe(0);
  });

  it("lists OpsDeck profiles and ~/.ssh/config hosts, not wildcards", () => {
    const t = m.targets({
      hosts: [{ id: "a", name: "web", group: "prod", host: "192.0.2.1", user: "ops" }],
      config: [{ alias: "gw", group: "", hostname: "gw.example.com", user: "" }, { alias: "*.internal", group: "", hostname: "", user: "" }],
    });
    expect(t).toEqual([
      { key: "id:a", name: "web", group: "prod", addr: "ops@192.0.2.1" },
      { key: "alias:gw", name: "gw", group: "", addr: "gw.example.com" },
    ]);
  });
});
