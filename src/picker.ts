import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { currentLang, startI18n } from "./i18n";
import { mountPicker } from "./modules/profiles";

startI18n();
invoke("set_lang", { lang: currentLang() }).catch(() => {});
document.body.classList.add("picking");
mountPicker(document.getElementById("app")!);
