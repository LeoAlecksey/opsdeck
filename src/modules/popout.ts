/**
 * Раздел в отдельном окне. Бэкенд открывает окно с меткой `pop-<раздел>` и той же страницей;
 * здесь — только то, что нужно интерфейсу: открыть, узнать список и отправить запрос обратно
 * в главное окно, когда модуль из вынесенного окна просит показать другой раздел.
 */
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { toast } from "./ui";
import { t } from "../i18n";

/** Что показать в главном окне: раздел и, если он понадобился из-за события, само событие. */
export type Route = { view: string; type?: string; detail?: unknown };

let views: Promise<Set<string>> | null = null;

/** Разделы, которые можно вынести (список ведёт бэкенд). */
export function popoutViews(): Promise<Set<string>> {
  views ??= invoke<string[]>("popout_views").then((list) => new Set(list)).catch(() => new Set<string>());
  return views;
}

export function popoutOpen(view: string) {
  invoke("window_popout", { view }).catch((e) => toast(String(e), "err"));
}

/** Вынесенное окно: показать раздел в главном окне и поднять его. */
export function routeToMain(view: string, type?: string, detail?: unknown) {
  const route: Route = { view, type, detail };
  emitTo("main", "popout-route", route)
    .then(() => invoke("window_focus_main"))
    .catch(() => toast(t("не удалось переключить главное окно"), "err"));
}
