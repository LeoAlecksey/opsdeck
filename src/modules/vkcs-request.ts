import { invoke as tauriInvoke } from "@tauri-apps/api/core";

// Shared across mounted views: join ongoing IPC work before it creates backend tasks.
const pending = new Map<string, Promise<unknown>>();

export function vkcsInvoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
  const key = JSON.stringify([command, Object.entries(args ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
  const current = pending.get(key);
  if (current) return current as Promise<T>;
  const request = tauriInvoke<T>(command, args).finally(() => {
    if (pending.get(key) === request) pending.delete(key);
  });
  pending.set(key, request);
  return request;
}
