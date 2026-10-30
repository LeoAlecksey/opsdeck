// Точка входа страницы: рабочее место окружения или, когда окружений несколько и окно ещё не
// выбрало своё, — выбор окружения (profile.rs решает это до загрузки страницы).
import { bootInfo } from "./modules/profiles";

if (bootInfo().picker) import("./picker");
else import("./main");
