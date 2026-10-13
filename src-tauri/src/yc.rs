//! Yandex Cloud через её же CLI `yc`: виртуальные машины, сети и доступы. Авторизация — профили
//! `yc init` самого пользователя, поэтому OpsDeck не хранит ни токенов, ни ключей сервисных
//! аккаунтов. Всё читается как `yc --format json …`, изменения — только по кнопке и с вопросом.

use crate::process;
use serde::Serialize;
use serde_json::Value;
use std::process::{Command, Stdio};

/// Идентификаторы и имена в Yandex Cloud: буквы, цифры, дефис, подчёркивание и точка.
/// Всё остальное в аргументы CLI не пускаем.
fn valid(id: &str) -> bool {
    !id.is_empty() && id.len() <= 200 && !id.starts_with('-') && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn check(id: &str) -> Result<&str, String> {
    valid(id).then_some(id).ok_or_else(|| format!("недопустимый идентификатор: {id}"))
}

/// `yc` с аргументами; stdout как есть (для `--format json` — JSON).
fn yc(args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("yc");
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    process::no_console(&mut cmd);
    let out = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "yc не найден в PATH — установите Yandex Cloud CLI и выполните «yc init»".to_string()
        } else {
            format!("не удалось запустить yc: {e}")
        }
    })?;
    if !out.status.success() {
        return Err(explain(&String::from_utf8_lossy(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn yc_json(args: &[&str]) -> Result<Value, String> {
    let mut a = vec!["--format", "json"];
    a.extend_from_slice(args);
    let text = yc(&a)?;
    if text.trim().is_empty() {
        return Ok(Value::Array(vec![]));
    }
    serde_json::from_str(&text).map_err(|e| format!("yc вернул не JSON: {e}"))
}

/// Понятный текст вместо простыни от CLI.
fn explain(stderr: &str) -> String {
    let line = stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("yc не ответил");
    if line.contains("Not authenticated") || line.contains("token has expired") || line.contains("OAuth") {
        return "нет входа в Yandex Cloud — выполните «yc init» (или «yc config set token …») в терминале".into();
    }
    if line.contains("PermissionDenied") || line.contains("Permission denied") {
        return "нет прав на эту операцию у текущего профиля yc".into();
    }
    if line.contains("NotFound") {
        return "объект не найден — возможно, выбрано другое облако или каталог".into();
    }
    line.chars().take(300).collect()
}

#[derive(Serialize, Default)]
pub struct Status {
    /// `yc` есть в PATH
    pub found: bool,
    pub version: String,
    /// активный профиль и список всех
    pub profile: String,
    pub profiles: Vec<String>,
    pub cloud_id: String,
    pub folder_id: String,
    /// что не так (нет CLI, нет входа)
    pub error: String,
}

/// Строки `yc config profile list`: «default ACTIVE» у активного.
fn parse_profiles(text: &str) -> (Vec<String>, String) {
    let mut all = Vec::new();
    let mut active = String::new();
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let Some(name) = it.next() else { continue };
        // «NAME» — заголовок таблицы, если CLI его печатает
        if !valid(name) || name == "NAME" {
            continue;
        }
        if line.contains("ACTIVE") {
            active = name.to_string();
        }
        all.push(name.to_string());
    }
    (all, active)
}

/// Есть ли CLI, кто вошёл и какие облако с каталогом выбраны в профиле.
#[tauri::command]
pub async fn yc_status() -> Status {
    tauri::async_runtime::spawn_blocking(|| {
        let mut s = Status::default();
        match yc(&["version"]) {
            Ok(v) => {
                s.found = true;
                s.version = v.lines().next().unwrap_or("").trim().to_string();
            }
            Err(e) => {
                s.error = e;
                return s;
            }
        }
        if let Ok(text) = yc(&["config", "profile", "list"]) {
            let (all, active) = parse_profiles(&text);
            s.profiles = all;
            s.profile = active;
        }
        // отдельными вызовами: незаданный параметр — не ошибка профиля
        s.cloud_id = yc(&["config", "get", "cloud-id"]).map(|v| v.trim().to_string()).unwrap_or_default();
        s.folder_id = yc(&["config", "get", "folder-id"]).map(|v| v.trim().to_string()).unwrap_or_default();
        if s.cloud_id.is_empty() && s.folder_id.is_empty() {
            s.error = "профиль yc не настроен — выполните «yc init» в терминале".into();
        }
        s
    })
    .await
    .unwrap_or_default()
}

/// Переключить активный профиль CLI (это меняет и его, и дальнейшие вызовы).
#[tauri::command]
pub async fn yc_use_profile(name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || yc(&["config", "profile", "activate", check(&name)?]).map(|_| ()))
        .await
        .map_err(crate::store::err)?
}

#[derive(Serialize, PartialEq, Debug)]
pub struct Named {
    pub id: String,
    pub name: String,
    /// для каталога — облако, для сети — ничего
    pub parent: String,
    pub description: String,
}

fn str_of(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn parse_named(v: &Value, parent_key: &str) -> Vec<Named> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|x| Named { id: str_of(x, "id"), name: str_of(x, "name"), parent: str_of(x, parent_key), description: str_of(x, "description") })
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn yc_clouds() -> Result<Vec<Named>, String> {
    tauri::async_runtime::spawn_blocking(|| yc_json(&["resource-manager", "cloud", "list"]).map(|v| parse_named(&v, "organization_id")))
        .await
        .map_err(crate::store::err)?
}

#[tauri::command]
pub async fn yc_folders(cloud_id: String) -> Result<Vec<Named>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        yc_json(&["resource-manager", "folder", "list", "--cloud-id", check(&cloud_id)?]).map(|v| parse_named(&v, "cloud_id"))
    })
    .await
    .map_err(crate::store::err)?
}

#[derive(Serialize, PartialEq, Debug)]
pub struct Instance {
    pub id: String,
    pub name: String,
    /// RUNNING / STOPPED / …
    pub status: String,
    pub zone: String,
    /// «standard-v3 · 2 vCPU · 4 ГБ» собирается на фронтенде из этих полей
    pub platform: String,
    pub cores: u64,
    pub memory: u64,
    /// доля ядра (5%, 20%, 100%) — у «прерываемых» и дешёвых машин бывает не 100
    pub core_fraction: u64,
    pub preemptible: bool,
    pub internal_ip: String,
    pub public_ip: String,
    pub subnet_id: String,
}

/// `yc compute instance list`: нужные поля из вложенных структур.
fn parse_instances(v: &Value) -> Vec<Instance> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|x| {
                    let res = x.get("resources");
                    let num = |key: &str| res.and_then(|r| r.get(key)).and_then(|n| n.as_str().and_then(|s| s.parse().ok()).or_else(|| n.as_u64())).unwrap_or(0);
                    let nic = x.get("network_interfaces").and_then(Value::as_array).and_then(|n| n.first());
                    let v4 = nic.and_then(|n| n.get("primary_v4_address"));
                    Instance {
                        id: str_of(x, "id"),
                        name: str_of(x, "name"),
                        status: str_of(x, "status"),
                        zone: str_of(x, "zone_id"),
                        platform: str_of(x, "platform_id"),
                        cores: num("cores"),
                        memory: num("memory"),
                        core_fraction: {
                            let f = num("core_fraction");
                            if f == 0 { 100 } else { f }
                        },
                        preemptible: x.get("scheduling_policy").and_then(|s| s.get("preemptible")).and_then(Value::as_bool).unwrap_or(false),
                        internal_ip: v4.map(|a| str_of(a, "address")).unwrap_or_default(),
                        public_ip: v4.and_then(|a| a.get("one_to_one_nat")).map(|n| str_of(n, "address")).unwrap_or_default(),
                        subnet_id: v4.map(|a| str_of(a, "subnet_id")).unwrap_or_default(),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn yc_instances(folder_id: String) -> Result<Vec<Instance>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        yc_json(&["compute", "instance", "list", "--folder-id", check(&folder_id)?]).map(|v| parse_instances(&v))
    })
    .await
    .map_err(crate::store::err)?
}

/// Включить, выключить или перезагрузить машину. Операция запускается и ждётся самим CLI.
#[tauri::command]
pub async fn yc_instance_op(id: String, op: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cmd = match op.as_str() {
            "start" => "start",
            "stop" => "stop",
            "restart" => "restart",
            _ => return Err("неизвестная операция".into()),
        };
        yc(&["compute", "instance", cmd, "--id", check(&id)?, "--async"]).map(|_| ())
    })
    .await
    .map_err(crate::store::err)?
}

// ---------- сети ----------

#[derive(Serialize, PartialEq, Debug)]
pub struct Subnet {
    pub id: String,
    pub name: String,
    pub network_id: String,
    pub zone: String,
    /// подсети IPv4 («10.128.0.0/24»), обычно одна
    pub cidrs: Vec<String>,
    pub route_table_id: String,
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

fn parse_subnets(v: &Value) -> Vec<Subnet> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|x| Subnet {
                    id: str_of(x, "id"),
                    name: str_of(x, "name"),
                    network_id: str_of(x, "network_id"),
                    zone: str_of(x, "zone_id"),
                    cidrs: strings(x.get("v4_cidr_blocks")),
                    route_table_id: str_of(x, "route_table_id"),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Правило группы безопасности в читаемом виде: куда, что и откуда.
#[derive(Serialize, PartialEq, Debug)]
pub struct Rule {
    /// INGRESS / EGRESS
    pub direction: String,
    /// tcp, udp, icmp или «любой»
    pub protocol: String,
    /// «22», «80-443» или «любые»
    pub ports: String,
    /// адреса, другая группа или «эта же группа»
    pub source: String,
    pub description: String,
}

#[derive(Serialize, PartialEq, Debug)]
pub struct SecGroup {
    pub id: String,
    pub name: String,
    pub network_id: String,
    pub rules: Vec<Rule>,
}

fn parse_rules(v: Option<&Value>) -> Vec<Rule> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|r| {
                    let p = r.get("ports");
                    let from = p.and_then(|x| x.get("from_port")).and_then(|x| x.as_str().map(str::to_string).or_else(|| x.as_u64().map(|n| n.to_string())));
                    let to = p.and_then(|x| x.get("to_port")).and_then(|x| x.as_str().map(str::to_string).or_else(|| x.as_u64().map(|n| n.to_string())));
                    let ports = match (from, to) {
                        (Some(f), Some(t)) if f == t => f,
                        (Some(f), Some(t)) => format!("{f}-{t}"),
                        (Some(f), None) => format!("от {f}"),
                        (None, Some(t)) => format!("до {t}"),
                        (None, None) => "любые".into(),
                    };
                    let cidrs = r.get("cidr_blocks").map(|c| [strings(c.get("v4_cidr_blocks")), strings(c.get("v6_cidr_blocks"))].concat()).unwrap_or_default();
                    let source = if !cidrs.is_empty() {
                        cidrs.join(", ")
                    } else if r.get("predefined_target").is_some() {
                        match str_of(r, "predefined_target").as_str() {
                            "self_security_group" => "эта же группа".into(),
                            "loadbalancer_healthchecks" => "проверки балансировщика".into(),
                            other => other.to_string(),
                        }
                    } else if let Some(id) = r.get("security_group_id").and_then(Value::as_str) {
                        format!("группа {id}")
                    } else {
                        "не указано".into()
                    };
                    let proto = str_of(r, "protocol_name");
                    Rule {
                        direction: str_of(r, "direction"),
                        protocol: if proto.is_empty() || proto == "ANY" { "любой".into() } else { proto.to_lowercase() },
                        ports,
                        source,
                        description: str_of(r, "description"),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_sec_groups(v: &Value) -> Vec<SecGroup> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|x| SecGroup { id: str_of(x, "id"), name: str_of(x, "name"), network_id: str_of(x, "network_id"), rules: parse_rules(x.get("rules")) })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Serialize, PartialEq, Debug)]
pub struct Address {
    pub id: String,
    pub address: String,
    /// зарезервирован (не пропадёт при удалении машины)
    pub reserved: bool,
    /// занят чем-нибудь прямо сейчас
    pub used: bool,
    pub zone: String,
    pub name: String,
}

fn parse_addresses(v: &Value) -> Vec<Address> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|x| Address {
                    id: str_of(x, "id"),
                    address: x.get("external_ipv4_address").map(|e| str_of(e, "address")).unwrap_or_default(),
                    reserved: x.get("reserved").and_then(Value::as_bool).unwrap_or(false),
                    used: x.get("used").and_then(Value::as_bool).unwrap_or(false),
                    zone: x.get("external_ipv4_address").map(|e| str_of(e, "zone_id")).unwrap_or_default(),
                    name: str_of(x, "name"),
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn yc_networks(folder_id: String) -> Result<Vec<Named>, String> {
    tauri::async_runtime::spawn_blocking(move || yc_json(&["vpc", "network", "list", "--folder-id", check(&folder_id)?]).map(|v| parse_named(&v, "folder_id")))
        .await
        .map_err(crate::store::err)?
}

#[tauri::command]
pub async fn yc_subnets(folder_id: String) -> Result<Vec<Subnet>, String> {
    tauri::async_runtime::spawn_blocking(move || yc_json(&["vpc", "subnet", "list", "--folder-id", check(&folder_id)?]).map(|v| parse_subnets(&v)))
        .await
        .map_err(crate::store::err)?
}

#[tauri::command]
pub async fn yc_sec_groups(folder_id: String) -> Result<Vec<SecGroup>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        yc_json(&["vpc", "security-group", "list", "--folder-id", check(&folder_id)?]).map(|v| parse_sec_groups(&v))
    })
    .await
    .map_err(crate::store::err)?
}

#[tauri::command]
pub async fn yc_addresses(folder_id: String) -> Result<Vec<Address>, String> {
    tauri::async_runtime::spawn_blocking(move || yc_json(&["vpc", "address", "list", "--folder-id", check(&folder_id)?]).map(|v| parse_addresses(&v)))
        .await
        .map_err(crate::store::err)?
}

// ---------- доступы и счёт ----------

/// Кто и с какой ролью имеет доступ к каталогу.
#[derive(Serialize, PartialEq, Debug)]
pub struct Binding {
    pub role: String,
    /// userAccount, serviceAccount, federatedUser, system…
    pub kind: String,
    pub subject: String,
}

fn parse_bindings(v: &Value) -> Vec<Binding> {
    let mut out: Vec<Binding> = v
        .as_array()
        .map(|a| {
            a.iter()
                .map(|x| {
                    let s = x.get("subject");
                    Binding {
                        role: str_of(x, "role_id"),
                        kind: s.map(|s| str_of(s, "type")).unwrap_or_default(),
                        subject: s.map(|s| str_of(s, "id")).unwrap_or_default(),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| a.role.cmp(&b.role).then_with(|| a.subject.cmp(&b.subject)));
    out
}

#[derive(Serialize, PartialEq, Debug)]
pub struct BillingAccount {
    pub id: String,
    pub name: String,
    pub balance: String,
    pub currency: String,
    pub active: bool,
}

fn parse_billing(v: &Value) -> Vec<BillingAccount> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|x| BillingAccount {
                    id: str_of(x, "id"),
                    name: str_of(x, "name"),
                    balance: str_of(x, "balance"),
                    currency: str_of(x, "currency"),
                    active: x.get("active").and_then(Value::as_bool).unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn yc_service_accounts(folder_id: String) -> Result<Vec<Named>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        yc_json(&["iam", "service-account", "list", "--folder-id", check(&folder_id)?]).map(|v| parse_named(&v, "folder_id"))
    })
    .await
    .map_err(crate::store::err)?
}

#[tauri::command]
pub async fn yc_bindings(folder_id: String) -> Result<Vec<Binding>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        yc_json(&["resource-manager", "folder", "list-access-bindings", check(&folder_id)?]).map(|v| parse_bindings(&v))
    })
    .await
    .map_err(crate::store::err)?
}

#[tauri::command]
pub async fn yc_billing() -> Result<Vec<BillingAccount>, String> {
    tauri::async_runtime::spawn_blocking(|| yc_json(&["billing", "account", "list"]).map(|v| parse_billing(&v)))
        .await
        .map_err(crate::store::err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subnets_and_addresses_are_read() {
        let v: Value = serde_json::from_str(
            r#"[{"id":"e9b1","name":"app-a","network_id":"enp1","zone_id":"ru-central1-a","v4_cidr_blocks":["10.128.0.0/24"],"route_table_id":"rt1"}]"#,
        )
        .unwrap();
        assert_eq!(
            parse_subnets(&v),
            [Subnet { id: "e9b1".into(), name: "app-a".into(), network_id: "enp1".into(), zone: "ru-central1-a".into(), cidrs: vec!["10.128.0.0/24".into()], route_table_id: "rt1".into() }]
        );
        let a: Value = serde_json::from_str(
            r#"[{"id":"e9a1","name":"nat","reserved":true,"used":true,"external_ipv4_address":{"address":"203.0.113.9","zone_id":"ru-central1-a"}},
                {"id":"e9a2","external_ipv4_address":{"address":"203.0.113.10","zone_id":"ru-central1-b"}}]"#,
        )
        .unwrap();
        let got = parse_addresses(&a);
        assert_eq!(got[0], Address { id: "e9a1".into(), address: "203.0.113.9".into(), reserved: true, used: true, zone: "ru-central1-a".into(), name: "nat".into() });
        assert!(!got[1].reserved && !got[1].used, "отсутствующие флаги — это «нет»");
    }

    /// Правила групп безопасности читаются глазами: порт, протокол и откуда.
    #[test]
    fn security_group_rules_are_made_readable() {
        let v: Value = serde_json::from_str(
            r#"[{"id":"enp9","name":"web","network_id":"enp1","rules":[
                {"direction":"INGRESS","protocol_name":"TCP","ports":{"from_port":"443","to_port":"443"},"cidr_blocks":{"v4_cidr_blocks":["0.0.0.0/0"]},"description":"https"},
                {"direction":"INGRESS","protocol_name":"TCP","ports":{"from_port":"30000","to_port":"32767"},"predefined_target":"self_security_group"},
                {"direction":"EGRESS","protocol_name":"ANY","cidr_blocks":{"v4_cidr_blocks":["0.0.0.0/0"]}},
                {"direction":"INGRESS","protocol_name":"ICMP","security_group_id":"enp8"}]}]"#,
        )
        .unwrap();
        let g = parse_sec_groups(&v);
        assert_eq!(g[0].name, "web");
        assert_eq!(
            g[0].rules[0],
            Rule { direction: "INGRESS".into(), protocol: "tcp".into(), ports: "443".into(), source: "0.0.0.0/0".into(), description: "https".into() }
        );
        assert_eq!((g[0].rules[1].ports.as_str(), g[0].rules[1].source.as_str()), ("30000-32767", "эта же группа"));
        assert_eq!((g[0].rules[2].protocol.as_str(), g[0].rules[2].ports.as_str()), ("любой", "любые"));
        assert_eq!(g[0].rules[3].source, "группа enp8");
    }

    #[test]
    fn access_bindings_and_billing_are_read() {
        let v: Value = serde_json::from_str(
            r#"[{"role_id":"viewer","subject":{"id":"aje2","type":"serviceAccount"}},{"role_id":"admin","subject":{"id":"ajeu","type":"userAccount"}}]"#,
        )
        .unwrap();
        assert_eq!(
            parse_bindings(&v),
            [Binding { role: "admin".into(), kind: "userAccount".into(), subject: "ajeu".into() },
             Binding { role: "viewer".into(), kind: "serviceAccount".into(), subject: "aje2".into() }],
            "роли отсортированы"
        );
        let b: Value = serde_json::from_str(r#"[{"id":"dn2","name":"основной","balance":"1234.56","currency":"RUB","active":true}]"#).unwrap();
        assert_eq!(parse_billing(&b)[0], BillingAccount { id: "dn2".into(), name: "основной".into(), balance: "1234.56".into(), currency: "RUB".into(), active: true });
    }


    #[test]
    fn only_safe_identifiers_reach_the_cli() {
        assert!(valid("fhm4aqv6nd1gvlbtj8cq"));
        assert!(valid("prod-folder_1.2"));
        assert!(!valid(""));
        assert!(!valid("--help"), "опция не может быть идентификатором");
        assert!(!valid("a b"));
        assert!(!valid("a;rm -rf /"));
        assert!(check("ok").is_ok() && check("не ок").is_err());
    }

    #[test]
    fn the_active_profile_is_found_in_the_list() {
        let text = "NAME     ACTIVE\ndefault  true ACTIVE\nwork     \n";
        let (all, active) = parse_profiles(text);
        assert_eq!(all, ["default", "work"], "заголовок таблицы профилем не считается");
        assert_eq!(active, "default");
        assert_eq!(parse_profiles("").1, "");
    }

    #[test]
    fn instances_are_read_with_their_addresses_and_resources() {
        // как отдаёт `yc --format json compute instance list`: числа строками, адреса во вложенных полях
        let v: Value = serde_json::from_str(
            r#"[{"id":"fhm1","name":"app-1","status":"RUNNING","zone_id":"ru-central1-a","platform_id":"standard-v3",
                 "resources":{"memory":"4294967296","cores":"2","core_fraction":"20"},
                 "scheduling_policy":{"preemptible":true},
                 "network_interfaces":[{"primary_v4_address":{"address":"10.128.0.7","subnet_id":"e9b1","one_to_one_nat":{"address":"203.0.113.7"}}}]},
                {"id":"fhm2","name":"db-1","status":"STOPPED","zone_id":"ru-central1-b","platform_id":"standard-v2",
                 "resources":{"memory":"8589934592","cores":"4"},
                 "network_interfaces":[{"primary_v4_address":{"address":"10.128.1.3","subnet_id":"e9b2"}}]}]"#,
        )
        .unwrap();
        let i = parse_instances(&v);
        assert_eq!(
            i[0],
            Instance {
                id: "fhm1".into(), name: "app-1".into(), status: "RUNNING".into(), zone: "ru-central1-a".into(),
                platform: "standard-v3".into(), cores: 2, memory: 4294967296, core_fraction: 20, preemptible: true,
                internal_ip: "10.128.0.7".into(), public_ip: "203.0.113.7".into(), subnet_id: "e9b1".into(),
            }
        );
        // без NAT публичного адреса нет, доля ядра по умолчанию 100
        assert_eq!((i[1].public_ip.as_str(), i[1].core_fraction, i[1].preemptible), ("", 100, false));
        assert!(parse_instances(&Value::Null).is_empty());
    }

    #[test]
    fn clouds_and_folders_are_read() {
        let v: Value = serde_json::from_str(r#"[{"id":"b1","name":"prod","cloud_id":"c1","description":"боевой"}]"#).unwrap();
        assert_eq!(parse_named(&v, "cloud_id"), [Named { id: "b1".into(), name: "prod".into(), parent: "c1".into(), description: "боевой".into() }]);
    }

    #[test]
    fn errors_are_explained() {
        assert!(explain("ERROR: Not authenticated. Please run yc init").contains("yc init"));
        assert!(explain("ERROR: rpc error: code = PermissionDenied").contains("нет прав"));
        assert!(explain("ERROR: rpc error: code = NotFound desc = instance not found").contains("не найден"));
        assert_eq!(explain(""), "yc не ответил");
    }
}
