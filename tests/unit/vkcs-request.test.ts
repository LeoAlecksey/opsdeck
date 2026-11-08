import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { vkcsInvoke } from "../../src/modules/vkcs-request";

it("joins identical in-flight IPC calls and allows a fresh request after completion", async () => {
  let finish!: (result: unknown) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const first = vkcsInvoke("vkcs_server_list", { cloud: "one", projectId: "p" });
  const second = vkcsInvoke("vkcs_server_list", { projectId: "p", cloud: "one" });
  expect(second).toBe(first);
  expect(invoke).toHaveBeenCalledTimes(1);
  finish(["vm"]);
  expect(await second).toEqual(["vm"]);
  vi.mocked(invoke).mockResolvedValueOnce([]);
  await vkcsInvoke("vkcs_server_list", { cloud: "one", projectId: "p" });
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("shares failures, then permits retry and keeps projects separate", async () => {
  vi.mocked(invoke).mockClear();
  let fail!: (error: unknown) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  const first = vkcsInvoke("vkcs_networks", { projectId: "one" });
  const second = vkcsInvoke("vkcs_networks", { projectId: "one" });
  vi.mocked(invoke).mockResolvedValueOnce(["other-project"]);
  expect(await vkcsInvoke("vkcs_networks", { projectId: "two" })).toEqual(["other-project"]);
  const failures = Promise.allSettled([first, second]);
  fail(new Error("timeout"));
  expect((await failures).every((r) => r.status === "rejected")).toBe(true);
  vi.mocked(invoke).mockResolvedValueOnce([]);
  await vkcsInvoke("vkcs_networks", { projectId: "one" });
  expect(invoke).toHaveBeenCalledTimes(3);
});
