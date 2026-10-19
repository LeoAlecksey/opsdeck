/**
 * Сторож со стороны страницы.
 *
 * Зависания главного потока в журнале уже видны («UI FREEZE» из diag.rs), но по ним не понять,
 * стояла ли при этом сама страница: webview — отдельный процесс, и его таймеры идут дальше, даже
 * когда главный поток занят системным вызовом. Если рядом с «UI FREEZE» нет строки отсюда —
 * страница работала, встало окно (буфер обмена, X11, D-Bus). Если есть — встало всё приложение
 * разом: своп, нехватка процессора, остановка процесса.
 */

const STEP = 500;
/** Меньшие задержки бывают и при обычной работе (сборка мусора, тяжёлая перерисовка). */
const REPORT = 2000;
/** Больше похоже на сон компьютера, чем на зависание: об этом писать не о чем. */
const SLEEP = 60_000;

/** Сколько писать в журнал по промежутку между тиками, или null — молчим. */
export function stallGap(elapsed: number): number | null {
  return elapsed >= REPORT && elapsed < SLEEP ? Math.round(elapsed) : null;
}

export function stallNote(gap: number, endedAt: number): string {
  return `страница стояла ${gap} мс (с ${new Date(endedAt - gap).toLocaleTimeString()})`;
}

export function watchJs(report: (message: string) => void) {
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const gap = stallGap(now - last);
    last = now;
    if (gap) report(stallNote(gap, now));
  }, STEP);
}
