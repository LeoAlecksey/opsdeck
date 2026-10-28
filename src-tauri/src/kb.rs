//! База знаний локального ИИ: шпаргалки по инструментам DevOps (knowledge/devops.md) и свои
//! сниппеты пользователя. К запросу подбираются подходящие темы, и их строки идут в подсказку
//! модели — поэтому «покажи поды с рестартами» превращается в команду с правильными флагами, а не
//! в выдумку. Всё локально: ничего никуда не отправляется, кроме выбранного пользователем ИИ.

use serde::Serialize;

/// Шпаргалка по одному инструменту.
#[derive(Serialize, PartialEq, Debug)]
pub struct Topic {
    /// как называется инструмент («kubectl», «systemd»)
    pub tool: String,
    /// слова, по которым узнаём тему в запросе
    pub aliases: Vec<String>,
    /// строки «команда — что делает»
    pub lines: Vec<String>,
}

const BUNDLED: &str = include_str!("../knowledge/devops.md");
const PRACTICE: &str = include_str!("../knowledge/practice.md");

/// Разбор файла базы: `# инструмент`, строка `алиасы:` и строки `- команда — описание`.
/// Комментарии HTML и пустые строки пропускаются.
pub fn parse(text: &str) -> Vec<Topic> {
    let mut out: Vec<Topic> = Vec::new();
    let mut in_comment = false;
    for raw in text.lines() {
        let line = raw.trim();
        if in_comment {
            in_comment = !line.contains("-->");
            continue;
        }
        if line.starts_with("<!--") {
            in_comment = !line.contains("-->");
            continue;
        }
        if let Some(tool) = line.strip_prefix("# ") {
            out.push(Topic { tool: tool.trim().to_string(), aliases: Vec::new(), lines: Vec::new() });
            continue;
        }
        let Some(topic) = out.last_mut() else { continue };
        if let Some(rest) = line.strip_prefix("алиасы:").or_else(|| line.strip_prefix("aliases:")) {
            topic.aliases = rest.split(',').map(|a| a.trim().to_lowercase()).filter(|a| !a.is_empty()).collect();
        } else if let Some(rest) = line.strip_prefix("- ") {
            topic.lines.push(rest.trim().to_string());
        }
    }
    out.retain(|t| !t.lines.is_empty());
    out
}

/// Слова запроса, обрезанные до основы: «неймспейсе», «неймспейса» и «namespaces» должны
/// находить одно и то же, а падежей в русском много.
fn words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '-' && c != '_')
        .filter(|w| w.chars().count() > 1)
        .map(stem)
        .collect()
}

/// Первые четыре символа слова: грубо, зато без словарей и одинаково для русского и английского
/// («диске» и «диск», «неймспейсе» и «namespace» сводятся к общему началу).
fn stem(w: &str) -> String {
    w.chars().take(4).collect()
}

/// Насколько тема подходит запросу: имя инструмента и алиасы весят много, слова из строк — мало.
fn score(t: &Topic, qs: &[String]) -> usize {
    let tool = t.tool.to_lowercase();
    let mut n = 0;
    for q in qs {
        // Короткое слово («yc», «ssh», «про») совпадает только целиком: иначе предлог «про»
        // находил бы «процессы». Длинное — по началу с любой стороны: «диск» ↔ «диски».
        let short = q.chars().count() <= 3;
        let alias_hit = |a: &&String| if short { a.as_str() == q } else { a.starts_with(q.as_str()) || q.starts_with(stem(a).as_str()) };
        let tool_hit = if short { tool == *q } else { tool.contains(q.as_str()) };
        if tool_hit || t.aliases.iter().any(|a| alias_hit(&a)) {
            n += 8;
        } else if !short && t.lines.iter().any(|l| l.to_lowercase().contains(q.as_str())) {
            n += 1;
        }
    }
    n
}

/// Темы под запрос: сначала самые подходящие, пустой список — если ничего не похоже
/// (тогда подсказка остаётся прежней и модель не отвлекается на лишнее).
pub fn pick<'a>(topics: &'a [Topic], request: &str, limit: usize) -> Vec<&'a Topic> {
    let qs = words(request);
    let mut scored: Vec<(usize, &Topic)> = topics.iter().map(|t| (score(t, &qs), t)).filter(|(n, _)| *n >= 8).collect();
    // при равном счёте — по порядку в файле, чтобы подсказка не менялась от запуска к запуску
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored.truncate(limit);
    scored.into_iter().map(|(_, t)| t).collect()
}

/// Строки темы, самые подходящие запросу первыми: в подсказку идёт немного строк, и лучше те,
/// в которых есть слова запроса.
fn best_lines<'a>(t: &'a Topic, qs: &[String], limit: usize, keep: fn(&str) -> bool) -> Vec<&'a str> {
    let mut lines: Vec<(usize, &str)> = t
        .lines
        .iter()
        .filter(|l| keep(l))
        .map(|l| {
            let low = l.to_lowercase();
            (qs.iter().filter(|q| low.contains(q.as_str())).count(), l.as_str())
        })
        .collect();
    let mut idx: Vec<usize> = (0..lines.len()).collect();
    idx.sort_by_key(|&i| std::cmp::Reverse(lines[i].0));
    idx.truncate(limit);
    idx.sort_unstable();
    lines = idx.into_iter().map(|i| lines[i]).collect();
    lines.into_iter().map(|(_, l)| l).collect()
}

/// Кусок подсказки для ИИ: «Справка по инструментам» с подобранными строками. Пусто — если тема
/// запроса в базе не нашлась.
pub fn hint(topics: &[Topic], request: &str, topics_limit: usize, lines_limit: usize) -> String {
    hint_where(topics, request, topics_limit, lines_limit, |_| true)
}

/// Справка для агента расследований: только строки, которые он может выполнить. Агент запускает
/// одну команду без шелла, и строка с трубой или перенаправлением научила бы его тому, что
/// политика всё равно отклонит, — шаг впустую.
pub fn agent_hint(topics: &[Topic], request: &str, topics_limit: usize, lines_limit: usize) -> String {
    hint_where(topics, request, topics_limit, lines_limit, single_command)
}

/// Команда из строки базы (до « — ») — одна, без трубы, перенаправления, подстановки и `sh -c`.
/// Заглушки вида `<pod>` перенаправлением не считаются.
pub fn single_command(line: &str) -> bool {
    let cmd = line.split(" — ").next().unwrap_or(line);
    let joined = ["|", ";", "&&", "$(", "`", " > ", ">>", "2>", "&>", " < ", "sh -c", "bash -c"];
    !joined.iter().any(|j| cmd.contains(j))
}

fn hint_where(topics: &[Topic], request: &str, topics_limit: usize, lines_limit: usize, keep: fn(&str) -> bool) -> String {
    let qs = words(request);
    let mut s = String::new();
    for t in pick(topics, request, topics_limit) {
        let lines = best_lines(t, &qs, lines_limit, keep);
        if lines.is_empty() {
            continue;
        }
        s += &format!("  {}:\n", t.tool);
        for l in lines {
            s += &format!("    {l}\n");
        }
    }
    if s.is_empty() {
        return s;
    }
    format!("Справка по инструментам (проверенные команды, подставь реальные значения вместо <…>):\n{s}")
}

/// Привычки DevOps-инженера (knowledge/practice.md) без служебного комментария — общая часть
/// инструкции чата и агента: порядок диагностики, осторожность с изменениями, секреты.
pub fn practice() -> String {
    strip_comments(PRACTICE)
}

fn strip_comments(text: &str) -> String {
    let mut out = Vec::new();
    let mut in_comment = false;
    for line in text.lines() {
        let t = line.trim();
        if in_comment {
            in_comment = !t.contains("-->");
            continue;
        }
        if t.starts_with("<!--") {
            in_comment = !t.contains("-->");
            continue;
        }
        if !t.is_empty() {
            out.push(t);
        }
    }
    out.join("\n")
}

/// База из файла рядом с приложением (если пользователь свою положил) или встроенная.
pub fn load() -> Vec<Topic> {
    if let Ok(dir) = crate::store::config_dir() {
        let own = dir.join("knowledge.md");
        if let Ok(text) = std::fs::read_to_string(&own) {
            let mut mine = parse(&text);
            if !mine.is_empty() {
                // свои темы идут первыми: при равном счёте выбирается то, что написал пользователь
                mine.extend(parse(BUNDLED));
                return mine;
            }
        }
    }
    parse(BUNDLED)
}

#[derive(Serialize)]
pub struct Info {
    /// названия инструментов, которые знает база
    pub tools: Vec<String>,
    pub lines: usize,
    /// путь к своему файлу (есть он или нет — видно по `own`)
    pub path: String,
    pub own: bool,
}

/// Что сейчас знает база — для раздела настроек и справки.
#[tauri::command]
pub async fn kb_info() -> Info {
    tauri::async_runtime::spawn_blocking(|| {
        let topics = load();
        let path = crate::store::config_dir().map(|d| d.join("knowledge.md")).unwrap_or_default();
        Info {
            tools: topics.iter().map(|t| t.tool.clone()).collect(),
            lines: topics.iter().map(|t| t.lines.len()).sum(),
            own: path.exists(),
            path: path.to_string_lossy().into_owned(),
        }
    })
    .await
    .unwrap_or(Info { tools: Vec::new(), lines: 0, path: String::new(), own: false })
}

/// Открыть папку со своим файлом базы; если файла нет — создать с примером, чтобы было что править.
#[tauri::command]
pub fn kb_open() -> Result<(), String> {
    let dir = crate::store::config_dir()?;
    let file = dir.join("knowledge.md");
    if !file.exists() {
        let sample = "# свои команды\n\
            алиасы: наш прод, раскатка, деплой\n\
            - make deploy-prod — раскатка прода\n\
            - kubectl -n shop rollout status deploy/api --timeout=120s — дождаться раскатки api\n\
            \n\
            Формат: «# инструмент», строка «алиасы:» со словами, по которым тема узнаётся в запросе,\n\
            и строки «- команда — что делает». Эти строки ИИ получает как справку, когда запрос похож\n\
            на тему. Свои темы идут перед встроенными.\n";
        std::fs::write(&file, sample).map_err(crate::store::err)?;
        crate::store::restrict(&file, 0o600)?;
    }
    crate::store::open_with_system(&dir.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_base_parses_and_every_topic_has_aliases() {
        let t = parse(BUNDLED);
        assert!(t.len() >= 23, "тем в базе: {}", t.len());
        assert!(t.iter().map(|x| x.lines.len()).sum::<usize>() >= 250, "команд в базе мало");
        for topic in &t {
            assert!(!topic.aliases.is_empty(), "{}: нет алиасов", topic.tool);
            assert!(topic.lines.iter().all(|l| l.contains(" — ")), "{}: строка без описания", topic.tool);
        }
        assert!(t.iter().any(|x| x.tool == "kubectl"));
        // комментарий в начале файла темой не становится
        assert!(!t.iter().any(|x| x.tool.contains("База знаний")));
    }

    #[test]
    fn parses_own_file() {
        let t = parse("# мой инструмент\nалиасы: моё, mine\n- cmd --flag — делает дело\nпросто текст\n");
        assert_eq!(t, [Topic { tool: "мой инструмент".into(), aliases: vec!["моё".into(), "mine".into()], lines: vec!["cmd --flag — делает дело".into()] }]);
        assert!(parse("# пусто\nалиасы: a\n").is_empty(), "тема без строк не нужна");
    }

    #[test]
    fn the_topic_is_found_by_russian_and_english_words() {
        let t = parse(BUNDLED);
        let tools = |q: &str| pick(&t, q, 2).iter().map(|x| x.tool.clone()).collect::<Vec<_>>();
        assert_eq!(tools("покажи поды с рестартами в неймспейсе shop")[0], "kubectl");
        assert_eq!(tools("why is the deployment not rolling out")[0], "kubectl");
        assert_eq!(tools("посмотреть логи службы за час")[0], "systemd");
        assert_eq!(tools("почему nginx отдаёт 502")[0], "nginx");
        assert_eq!(tools("как в yc посмотреть машины")[0], "yandex cloud", "короткое имя инструмента ловится целиком");
        assert_eq!(tools("сколько места на диске")[0], "диски и файлы");
        assert_eq!(tools("какие порты слушает хост")[0], "сеть и dns");
        assert_eq!(tools("когда истекает сертификат сайта")[0], "сертификаты");
        assert_eq!(tools("что ещё не отправлено в удалённую ветку")[0], "git");
        // темы, добавленные по просьбе пользователя
        assert_eq!(tools("лаг консьюмер-группы в кафке")[0], "kafka");
        assert_eq!(tools("какие ключи занимают память в redis")[0], "redis");
        assert_eq!(tools("достать секрет из vault")[0], "vault");
        assert_eq!(tools("доля пятисотых в prometheus")[0], "promql");
        assert_eq!(tools("незавершённые мутации в clickhouse")[0], "clickhouse");
        // ничего похожего — подсказка не растёт
        assert!(pick(&t, "напиши стихотворение про осень", 3).is_empty());
    }

    #[test]
    fn the_hint_has_the_matching_lines_and_nothing_else() {
        let t = parse(BUNDLED);
        let h = hint(&t, "перезапустить деплой в неймспейсе shop", 1, 4);
        assert!(h.starts_with("Справка по инструментам"));
        assert!(h.contains("kubectl"));
        assert!(h.contains("rollout restart"), "{h}");
        assert_eq!(h.lines().count(), 1 + 1 + 4, "заголовок, инструмент и четыре строки");
        assert_eq!(hint(&t, "спой песню", 2, 4), "", "не про инструменты — подсказки нет");
    }

    #[test]
    fn the_agent_hint_has_only_commands_it_can_run() {
        let t = parse(BUNDLED);
        assert!(single_command("kubectl -n <ns> logs <pod> --previous — логи упавшего контейнера"), "заглушки — не перенаправление");
        for l in ["kubectl get pods -A | grep -v Running — не Running", "du -sh * 2>/dev/null — размер", "a && b — два шага", "sh -c 'ps' — шелл"] {
            assert!(!single_command(l), "{l}");
        }
        let h = agent_hint(&t, "почему поды в неймспейсе shop перезапускаются", 2, 6);
        assert!(h.contains("kubectl"), "{h}");
        assert!(h.lines().skip(1).filter(|l| l.starts_with("    ")).all(single_command), "{h}");
        assert_eq!(agent_hint(&t, "спой песню", 2, 6), "");
    }

    #[test]
    fn practice_is_the_text_without_the_comment() {
        let p = practice();
        assert!(p.starts_with("Как работает DevOps-инженер"), "{p}");
        assert!(!p.contains("<!--") && !p.contains("-->") && !p.contains("4096"), "служебный комментарий не уходит модели");
        assert!(p.contains("Сначала смотреть, потом менять") && p.contains("секреты"));
        // инструкция идёт в каждый запрос при контексте 4096 токенов — разрастаться ей нельзя
        assert!(p.chars().count() < 1800, "привычки разрослись: {} символов", p.chars().count());
        assert_eq!(strip_comments("<!-- a\nb -->\n\nтекст\n<!-- c -->\n- d\n"), "текст\n- d");
    }

    #[test]
    fn own_topics_go_before_the_bundled_ones() {
        let mut mine = parse("# свои команды\nалиасы: прод, деплой\n- make deploy-prod — раскатка прода\n");
        mine.extend(parse(BUNDLED));
        assert_eq!(pick(&mine, "деплой прода", 1)[0].tool, "свои команды");
    }
}
