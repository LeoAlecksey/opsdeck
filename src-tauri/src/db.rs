//! Databases panel: saved connections (PostgreSQL, MySQL/MariaDB, ClickHouse, Redis, MongoDB),
//! running queries and browsing the structure. Passwords come from KeePass or the OS keyring.
//! "Read-only" profiles are enforced by the server where it can (PostgreSQL, ClickHouse) and by
//! an allow-list of read statements/commands everywhere else.

use crate::{
    dbtunnel::{self, TunnelState},
    keepass::{self, KeepassState},
    store::{self, err},
    tools::valid_host,
};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::State;

const FILE: &str = "databases.json";
/// Rows shown per result; the rest is dropped (the status line says so).
const MAX_ROWS: usize = 1000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const QUERY_TIMEOUT: Duration = Duration::from_secs(300);
const TREE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize, Deserialize, Clone)]
pub struct DbProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub group: String,
    /// postgres | mysql | clickhouse | redis | mongodb
    pub engine: String,
    pub host: String,
    pub port: u16,
    /// default database (PostgreSQL: database to connect to; Redis: db number)
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub username: String,
    /// keepass | password | none
    #[serde(default = "default_auth")]
    pub auth: String,
    #[serde(default)]
    pub keepass_entry: String,
    /// off | require (encrypt, don't check the certificate) | verify
    #[serde(default = "default_tls")]
    pub tls: String,
    #[serde(default)]
    pub readonly: bool,
    /// MongoDB: extra URI options ("authSource=admin&replicaSet=rs0")
    #[serde(default)]
    pub options: String,
    /// reach the server through an SSH bastion: "" | "id:<SSH profile>" | "alias:<Host in ~/.ssh/config>"
    #[serde(default)]
    pub jump: String,
}

fn default_auth() -> String {
    "password".into()
}
fn default_tls() -> String {
    "off".into()
}

#[derive(Serialize, Default)]
pub struct QueryResult {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    /// rows changed by the last statement, when it returned no rows
    affected: Option<u64>,
    truncated: bool,
    elapsed_ms: u64,
    message: String,
    /// MongoDB: the documents as JSON, for the JSON view
    docs: Option<Vec<Json>>,
}

#[derive(Serialize)]
pub struct Node {
    name: String,
    /// database | schema | table | view | column | index | key | collection | field | info
    kind: String,
    detail: String,
    leaf: bool,
    /// query to put in the editor on double-click
    query: Option<String>,
}

fn node(name: impl Into<String>, kind: &str, detail: impl Into<String>, leaf: bool, query: Option<String>) -> Node {
    Node { name: name.into(), kind: kind.into(), detail: detail.into(), leaf, query }
}

fn secret_key(id: &str) -> String {
    format!("db:{id}")
}

fn load() -> Result<Vec<DbProfile>, String> {
    store::load_json(FILE)
}

fn find(id: &str) -> Result<DbProfile, String> {
    load()?.into_iter().find(|d| d.id == id).ok_or_else(|| "подключение не найдено".into())
}

/// Username from the profile overrides the KeePass entry's one.
fn credentials(kp: &KeepassState, p: &DbProfile) -> Result<(String, String), String> {
    match p.auth.as_str() {
        "keepass" => {
            let (u, pw) = keepass::credentials(kp, &p.keepass_entry)?;
            Ok((if p.username.is_empty() { u } else { p.username.clone() }, pw))
        }
        "password" => Ok((p.username.clone(), store::secret_get(&secret_key(&p.id)).unwrap_or_default())),
        _ => Ok((p.username.clone(), String::new())),
    }
}

#[tauri::command]
pub fn db_list() -> Result<Vec<DbProfile>, String> {
    load()
}

#[tauri::command]
pub fn db_save(profile: DbProfile, secret: Option<String>) -> Result<(), String> {
    if !store::valid_id(&profile.id) {
        return Err("invalid id".into());
    }
    if !valid_host(&profile.host) {
        return Err("некорректный адрес".into());
    }
    if !["postgres", "mysql", "clickhouse", "redis", "mongodb"].contains(&profile.engine.as_str()) {
        return Err("неизвестный тип базы".into());
    }
    if !profile.jump.is_empty() && !profile.jump.starts_with("id:") && !profile.jump.starts_with("alias:") {
        return Err("неизвестный jump-хост".into());
    }
    if profile.auth == "keepass" && profile.keepass_entry.is_empty() {
        return Err("выберите запись KeePass".into());
    }
    if let Some(s) = secret.filter(|s| !s.is_empty()) {
        store::secret_set(&secret_key(&profile.id), &s)?;
    }
    let mut list = load()?;
    match list.iter_mut().find(|d| d.id == profile.id) {
        Some(d) => *d = profile,
        None => list.push(profile),
    }
    store::save_json(FILE, &list)
}

#[tauri::command]
pub fn db_delete(tunnels: State<TunnelState>, id: String) -> Result<(), String> {
    dbtunnel::close(&tunnels, &id);
    let mut list = load()?;
    list.retain(|d| d.id != id);
    store::secret_delete(&secret_key(&id));
    store::save_json(FILE, &list)
}

/// Everything a driver needs for one request.
struct Ctx {
    p: DbProfile,
    user: String,
    pass: String,
}

/// The profile with its credentials; with a jump host the address is the local end of an SSH tunnel.
async fn ctx(kp: &KeepassState, tunnels: &TunnelState, id: &str) -> Result<Ctx, String> {
    let p = find(id)?;
    let (user, pass) = credentials(kp, &p)?;
    let mut c = Ctx { p, user, pass };
    if !c.p.jump.is_empty() {
        if c.p.tls == "verify" {
            return Err("через jump-хост шифрование «verify» не работает: сертификат сверяется с адресом 127.0.0.1 — выберите «require»".into());
        }
        c.p.port = dbtunnel::open(tunnels, &c.p.id, &c.p.jump, &c.p.host, c.p.port).await?;
        c.p.host = "127.0.0.1".into();
    }
    Ok(c)
}

async fn timed<T>(limit: Duration, f: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    tokio::time::timeout(limit, f).await.map_err(|_| format!("нет ответа за {} с", limit.as_secs()))?
}

/// Check the connection; returns the server version.
#[tauri::command]
pub async fn db_test(kp: State<'_, KeepassState>, tunnels: State<'_, TunnelState>, id: String) -> Result<String, String> {
    let c = ctx(&kp, &tunnels, &id).await?;
    let q = match c.p.engine.as_str() {
        "postgres" => "SELECT version()",
        "mysql" => "SELECT CONCAT(@@version_comment, ' ', VERSION())",
        "clickhouse" => "SELECT concat('ClickHouse ', version())",
        "redis" => "INFO server",
        _ => "{ buildInfo: 1 }",
    };
    let r = timed(TREE_TIMEOUT, run(&c, q, None)).await?;
    let v = match c.p.engine.as_str() {
        "redis" => r
            .rows
            .iter()
            .filter_map(|row| row.get(1).cloned().flatten())
            .find_map(|s| s.lines().find(|l| l.starts_with("redis_version:")).map(|l| format!("Redis {}", &l[14..])))
            .unwrap_or_else(|| "Redis".into()),
        "mongodb" => r
            .docs
            .as_ref()
            .and_then(|d| d.first())
            .and_then(|d| d.get("version"))
            .and_then(Json::as_str)
            .map(|v| format!("MongoDB {v}"))
            .unwrap_or_else(|| "MongoDB".into()),
        _ => r.rows.first().and_then(|row| row.first().cloned().flatten()).unwrap_or_default(),
    };
    Ok(v.trim().to_string())
}

/// Run what the user typed. `database` is the database/schema chosen in the panel (Redis: "db3").
#[tauri::command]
pub async fn db_query(kp: State<'_, KeepassState>, tunnels: State<'_, TunnelState>, id: String, query: String, database: Option<String>) -> Result<QueryResult, String> {
    let c = ctx(&kp, &tunnels, &id).await?;
    let started = Instant::now();
    let mut r = timed(QUERY_TIMEOUT, run(&c, &query, database.filter(|d| !d.is_empty()).as_deref())).await?;
    r.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(r)
}

/// Children of a node in the structure tree; `path` is empty for the top level.
#[tauri::command]
pub async fn db_tree(kp: State<'_, KeepassState>, tunnels: State<'_, TunnelState>, id: String, path: Vec<String>) -> Result<Vec<Node>, String> {
    let c = ctx(&kp, &tunnels, &id).await?;
    timed(TREE_TIMEOUT, async {
        match c.p.engine.as_str() {
            "postgres" => pg_tree(&c, &path).await,
            "mysql" => my_tree(&c, &path).await,
            "clickhouse" => ch_tree(&c, &path).await,
            "redis" => redis_tree(&c, &path).await,
            _ => mongo_tree(&c, &path).await,
        }
    })
    .await
}

async fn run(c: &Ctx, q: &str, db: Option<&str>) -> Result<QueryResult, String> {
    if q.trim().is_empty() {
        return Err("пустой запрос".into());
    }
    match c.p.engine.as_str() {
        "postgres" => pg_query(c, q, db).await,
        "mysql" => my_query(c, q, db).await,
        "clickhouse" => ch_query(c, q, db, &[]).await,
        "redis" => redis_query(c, q, db).await,
        _ => mongo_query(c, q, db).await,
    }
}

// ---------- read-only guard for engines without a server-side switch ----------

/// Statements split on `;` outside quotes/comments, trimmed, empty ones dropped.
fn statements(sql: &str) -> Vec<String> {
    let (mut out, mut cur) = (Vec::new(), String::new());
    let mut quote: Option<char> = None;
    let mut chars = sql.chars().peekable();
    while let Some(ch) = chars.next() {
        match quote {
            Some(q) => {
                cur.push(ch);
                if ch == '\\' {
                    if let Some(n) = chars.next() {
                        cur.push(n);
                    }
                } else if ch == q {
                    quote = None;
                }
            }
            None => match ch {
                '\'' | '"' | '`' => {
                    quote = Some(ch);
                    cur.push(ch);
                }
                '-' if chars.peek() == Some(&'-') => {
                    for n in chars.by_ref() {
                        if n == '\n' {
                            break;
                        }
                    }
                    cur.push(' ');
                }
                '#' => {
                    for n in chars.by_ref() {
                        if n == '\n' {
                            break;
                        }
                    }
                    cur.push(' ');
                }
                '/' if chars.peek() == Some(&'*') => {
                    chars.next();
                    let mut prev = ' ';
                    for n in chars.by_ref() {
                        if prev == '*' && n == '/' {
                            break;
                        }
                        prev = n;
                    }
                    cur.push(' ');
                }
                ';' => out.push(std::mem::take(&mut cur)),
                _ => cur.push(ch),
            },
        }
    }
    out.push(cur);
    out.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

fn first_word(s: &str) -> String {
    s.trim_start_matches('(').split(|c: char| !c.is_ascii_alphanumeric() && c != '_').next().unwrap_or("").to_ascii_uppercase()
}

fn sql_read_only(sql: &str) -> Result<(), String> {
    const READ: &[&str] = &["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "WITH", "USE", "HELP", "VALUES", "TABLE"];
    for st in statements(sql) {
        let w = first_word(&st);
        // SELECT ... INTO OUTFILE / FOR UPDATE take locks or write files
        let up = st.to_ascii_uppercase();
        if !READ.contains(&w.as_str()) || up.contains(" INTO OUTFILE") || up.contains(" INTO DUMPFILE") || up.contains(" FOR UPDATE") {
            return Err(format!("подключение только для чтения: «{}» не выполняется", w.to_lowercase()));
        }
    }
    Ok(())
}

// ---------- TLS (rustls, ring) ----------

fn tls_config(verify: bool) -> rustls::ClientConfig {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("ring supports the default protocol versions");
    if verify {
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        builder.with_root_certificates(roots).with_no_client_auth()
    } else {
        builder.dangerous().with_custom_certificate_verifier(Arc::new(NoVerify(provider))).with_no_client_auth()
    }
}

/// tls = "require": encrypted, certificate not checked (like libpq sslmode=require).
#[derive(Debug)]
struct NoVerify(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>,
        _: &[u8],
        _: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

// ---------- PostgreSQL ----------

fn pg_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
fn sql_lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

async fn pg_connect(c: &Ctx, db: Option<&str>) -> Result<tokio_postgres::Client, String> {
    let mut cfg = tokio_postgres::Config::new();
    let db = db.map(str::to_string).unwrap_or_else(|| if c.p.database.is_empty() { "postgres".into() } else { c.p.database.clone() });
    cfg.host(&c.p.host)
        .port(c.p.port)
        .user(if c.user.is_empty() { "postgres" } else { &c.user })
        .dbname(&db)
        .application_name("OpsDeck")
        .connect_timeout(CONNECT_TIMEOUT);
    if !c.pass.is_empty() {
        cfg.password(&c.pass);
    }
    // enforced by the server: any write fails with "cannot execute ... in a read-only transaction"
    if c.p.readonly {
        cfg.options("-c default_transaction_read_only=on");
    }
    let e = |e: tokio_postgres::Error| format!("PostgreSQL {}:{}: {e}", c.p.host, c.p.port);
    if c.p.tls == "off" {
        let (client, conn) = cfg.connect(tokio_postgres::NoTls).await.map_err(e)?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        Ok(client)
    } else {
        cfg.ssl_mode(tokio_postgres::config::SslMode::Require);
        let tls = tokio_postgres_rustls::MakeRustlsConnect::new(tls_config(c.p.tls == "verify"));
        let (client, conn) = cfg.connect(tls).await.map_err(e)?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        Ok(client)
    }
}

async fn pg_query(c: &Ctx, q: &str, db: Option<&str>) -> Result<QueryResult, String> {
    use tokio_postgres::SimpleQueryMessage as M;
    let client = pg_connect(c, db).await?;
    let stream = client.simple_query_raw(q).await.map_err(|e| pg_err(&e))?;
    futures::pin_mut!(stream);
    let mut r = QueryResult::default();
    // the last statement that returned rows wins; a later write only reports its count
    let (mut cols, mut rows, mut truncated, mut in_set) = (Vec::new(), Vec::new(), false, false);
    while let Some(m) = stream.next().await {
        match m.map_err(|e| pg_err(&e))? {
            M::RowDescription(d) => {
                cols = d.iter().map(|c| c.name().to_string()).collect();
                rows = Vec::new();
                truncated = false;
                in_set = true;
            }
            M::Row(row) => {
                if rows.len() < MAX_ROWS {
                    rows.push((0..row.len()).map(|i| row.get(i).map(str::to_string)).collect());
                } else {
                    truncated = true;
                }
            }
            M::CommandComplete(n) => {
                if in_set {
                    r.columns = std::mem::take(&mut cols);
                    r.rows = std::mem::take(&mut rows);
                    r.truncated = truncated;
                    r.affected = None;
                    r.message = format!("{n} строк");
                    in_set = false;
                } else {
                    r.affected = Some(n);
                    r.message = format!("затронуто строк: {n}");
                }
            }
            _ => {}
        }
    }
    Ok(r)
}

fn pg_err(e: &tokio_postgres::Error) -> String {
    match e.as_db_error() {
        Some(d) => {
            let mut s = format!("{}: {}", d.severity(), d.message());
            if let Some(h) = d.hint() {
                s += &format!("\nподсказка: {h}");
            }
            if let Some(p) = d.position() {
                s += &format!("\nпозиция: {p:?}");
            }
            s
        }
        None => e.to_string(),
    }
}

async fn pg_rows(c: &Ctx, db: Option<&str>, q: &str) -> Result<Vec<Vec<String>>, String> {
    let r = pg_query(c, q, db).await?;
    Ok(r.rows.into_iter().map(|row| row.into_iter().map(Option::unwrap_or_default).collect()).collect())
}

async fn pg_tree(c: &Ctx, path: &[String]) -> Result<Vec<Node>, String> {
    match path {
        [] => {
            let rows = pg_rows(c, None, "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1").await?;
            Ok(rows.into_iter().map(|r| node(&r[0], "database", "", false, None)).collect())
        }
        [db] => {
            let rows = pg_rows(
                c,
                Some(db),
                "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY nspname = 'public' DESC, 1",
            )
            .await?;
            Ok(rows.into_iter().map(|r| node(&r[0], "schema", "", false, None)).collect())
        }
        [db, schema] => {
            let q = format!(
                "SELECT c.relname, c.relkind, greatest(c.reltuples, 0)::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = {} AND c.relkind IN ('r','v','m','p','f') AND NOT c.relispartition ORDER BY 1",
                sql_lit(schema)
            );
            let rows = pg_rows(c, Some(db), &q).await?;
            Ok(rows
                .into_iter()
                .map(|r| {
                    let (kind, label) = match r[1].as_str() {
                        "v" => ("view", "представление"),
                        "m" => ("view", "мат. представление"),
                        "p" => ("table", "секционированная"),
                        "f" => ("table", "внешняя"),
                        _ => ("table", ""),
                    };
                    let detail = if kind == "table" && r[2] != "0" { format!("{label} ~{} строк", r[2]).trim().to_string() } else { label.to_string() };
                    let sel = format!("SELECT * FROM {}.{} LIMIT 100;", pg_ident(schema), pg_ident(&r[0]));
                    node(&r[0], kind, detail, false, Some(sel))
                })
                .collect())
        }
        [db, schema, table] => {
            let rel = sql_lit(&format!("{}.{}", pg_ident(schema), pg_ident(table)));
            let cols = pg_rows(
                c,
                Some(db),
                &format!(
                    "SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, \
                     coalesce((SELECT true FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)), false) \
                     FROM pg_attribute a WHERE a.attrelid = {rel}::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum"
                ),
            )
            .await?;
            let idx = pg_rows(
                c,
                Some(db),
                &format!("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = {} AND tablename = {} ORDER BY 1", sql_lit(schema), sql_lit(table)),
            )
            .await?;
            let mut out: Vec<Node> = cols
                .into_iter()
                .map(|r| {
                    let mut d = r[1].clone();
                    if r[3] == "t" {
                        d += " · PK";
                    } else if r[2] == "t" {
                        d += " · NOT NULL";
                    }
                    node(&r[0], "column", d, true, None)
                })
                .collect();
            out.extend(idx.into_iter().map(|r| node(&r[0], "index", r[1].clone(), true, None)));
            Ok(out)
        }
        _ => Ok(Vec::new()),
    }
}

// ---------- MySQL / MariaDB ----------

async fn my_connect(c: &Ctx, db: Option<&str>) -> Result<mysql_async::Conn, String> {
    let db = db.map(str::to_string).or_else(|| (!c.p.database.is_empty()).then(|| c.p.database.clone()));
    let mut opts = mysql_async::OptsBuilder::default()
        .ip_or_hostname(c.p.host.clone())
        .tcp_port(c.p.port)
        .user(Some(if c.user.is_empty() { "root".to_string() } else { c.user.clone() }))
        .db_name(db)
        .prefer_socket(false);
    if !c.pass.is_empty() {
        opts = opts.pass(Some(c.pass.clone()));
    }
    if c.p.tls != "off" {
        opts = opts.ssl_opts(Some(mysql_async::SslOpts::default().with_danger_accept_invalid_certs(c.p.tls == "require")));
    }
    let mut conn = tokio::time::timeout(CONNECT_TIMEOUT, mysql_async::Conn::new(opts))
        .await
        .map_err(|_| format!("MySQL {}:{}: нет ответа за {} с", c.p.host, c.p.port, CONNECT_TIMEOUT.as_secs()))?
        .map_err(|e| format!("MySQL {}:{}: {e}", c.p.host, c.p.port))?;
    if c.p.readonly {
        use mysql_async::prelude::Queryable;
        conn.query_drop("SET SESSION TRANSACTION READ ONLY").await.map_err(err)?;
    }
    Ok(conn)
}

fn my_value(v: &mysql_async::Value) -> Option<String> {
    use mysql_async::Value as V;
    Some(match v {
        V::NULL => return None,
        V::Bytes(b) => match std::str::from_utf8(b) {
            Ok(s) => s.to_string(),
            Err(_) => format!("0x{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>()),
        },
        V::Int(i) => i.to_string(),
        V::UInt(u) => u.to_string(),
        V::Float(f) => f.to_string(),
        V::Double(d) => d.to_string(),
        V::Date(y, mo, d, h, mi, s, us) => {
            if *us > 0 {
                format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}.{us:06}")
            } else {
                format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
            }
        }
        V::Time(neg, d, h, mi, s, us) => {
            let h = *d * 24 + u32::from(*h);
            format!("{}{h:02}:{mi:02}:{s:02}{}", if *neg { "-" } else { "" }, if *us > 0 { format!(".{us:06}") } else { String::new() })
        }
    })
}

async fn my_query(c: &Ctx, q: &str, db: Option<&str>) -> Result<QueryResult, String> {
    use mysql_async::prelude::Queryable;
    if c.p.readonly {
        sql_read_only(q)?;
    }
    let mut conn = my_connect(c, db).await?;
    let mut r = QueryResult::default();
    {
        let mut res = conn.query_iter(q).await.map_err(err)?;
        while !res.is_empty() {
            let cols: Vec<String> = res.columns().map(|c| c.iter().map(|c| c.name_str().into_owned()).collect()).unwrap_or_default();
            let (mut rows, mut truncated) = (Vec::new(), false);
            while let Some(row) = res.next().await.map_err(err)? {
                if rows.len() < MAX_ROWS {
                    rows.push(row.unwrap().iter().map(my_value).collect());
                } else {
                    truncated = true;
                }
            }
            if cols.is_empty() {
                r.affected = Some(res.affected_rows());
                r.message = format!("затронуто строк: {}", res.affected_rows());
            } else {
                r.message = format!("{} строк", rows.len() + usize::from(truncated));
                r.columns = cols;
                r.rows = rows;
                r.truncated = truncated;
                r.affected = None;
            }
        }
    }
    let _ = conn.disconnect().await;
    Ok(r)
}

async fn my_rows(c: &Ctx, sql: &str, params: Vec<String>) -> Result<Vec<Vec<String>>, String> {
    use mysql_async::prelude::Queryable;
    let mut conn = my_connect(c, None).await?;
    let rows: Vec<mysql_async::Row> = conn.exec(sql, params).await.map_err(err)?;
    let _ = conn.disconnect().await;
    Ok(rows.into_iter().map(|r| r.unwrap().iter().map(|v| my_value(v).unwrap_or_default()).collect()).collect())
}

fn my_ident(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
}

async fn my_tree(c: &Ctx, path: &[String]) -> Result<Vec<Node>, String> {
    match path {
        [] => {
            let rows = my_rows(c, "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME IN ('mysql','sys','information_schema','performance_schema'), 1", vec![]).await?;
            Ok(rows.into_iter().map(|r| node(&r[0], "database", "", false, None)).collect())
        }
        [db] => {
            let rows = my_rows(
                c,
                "SELECT TABLE_NAME, TABLE_TYPE, COALESCE(TABLE_ROWS, 0), COALESCE(ENGINE, '') FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY 1",
                vec![db.clone()],
            )
            .await?;
            Ok(rows
                .into_iter()
                .map(|r| {
                    let view = r[1].contains("VIEW");
                    let detail = if view { "представление".to_string() } else { format!("{} ~{} строк", r[3], r[2]).trim().to_string() };
                    let sel = format!("SELECT * FROM {}.{} LIMIT 100;", my_ident(db), my_ident(&r[0]));
                    node(&r[0], if view { "view" } else { "table" }, detail, false, Some(sel))
                })
                .collect())
        }
        [db, table] => {
            let cols = my_rows(
                c,
                "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
                vec![db.clone(), table.clone()],
            )
            .await?;
            let idx = my_rows(
                c,
                "SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', '), MAX(NON_UNIQUE) FROM information_schema.STATISTICS \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? GROUP BY INDEX_NAME ORDER BY INDEX_NAME <> 'PRIMARY', 1",
                vec![db.clone(), table.clone()],
            )
            .await?;
            let mut out: Vec<Node> = cols
                .into_iter()
                .map(|r| {
                    let mut d = r[1].clone();
                    match r[3].as_str() {
                        "PRI" => d += " · PK",
                        "UNI" => d += " · UNIQUE",
                        _ if r[2] == "NO" => d += " · NOT NULL",
                        _ => {}
                    }
                    node(&r[0], "column", d, true, None)
                })
                .collect();
            out.extend(idx.into_iter().map(|r| {
                let d = format!("{}({})", if r[2] == "0" { "UNIQUE " } else { "" }, r[1]);
                node(&r[0], "index", d, true, None)
            }));
            Ok(out)
        }
        _ => Ok(Vec::new()),
    }
}

// ---------- ClickHouse (HTTP interface) ----------

fn ch_ident(s: &str) -> String {
    format!("`{}`", s.replace('\\', "\\\\").replace('`', "\\`"))
}

/// `params` are ClickHouse query parameters: `{name:String}` in the query, `param_name=` in the URL.
async fn ch_query(c: &Ctx, q: &str, db: Option<&str>, params: &[(&str, &str)]) -> Result<QueryResult, String> {
    let scheme = if c.p.tls == "off" { "http" } else { "https" };
    let mut url = tauri::Url::parse(&format!("{scheme}://{}:{}/", c.p.host, c.p.port)).map_err(err)?;
    {
        let mut qp = url.query_pairs_mut();
        let db = db.map(str::to_string).or_else(|| (!c.p.database.is_empty()).then(|| c.p.database.clone()));
        if let Some(db) = db {
            qp.append_pair("database", &db);
        }
        // for queries without their own FORMAT clause
        qp.append_pair("default_format", "JSONCompact");
        qp.append_pair("max_result_rows", &(MAX_ROWS + 1).to_string());
        qp.append_pair("result_overflow_mode", "break");
        // 2 = only reads, but settings (like the ones above) may still be set; enforced by the server
        if c.p.readonly {
            qp.append_pair("readonly", "2");
        }
        for (k, v) in params {
            qp.append_pair(&format!("param_{k}"), v);
        }
    }
    let http = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .danger_accept_invalid_certs(c.p.tls == "require")
        .build()
        .map_err(err)?;
    let mut req = http.post(url).body(q.to_string());
    if !c.user.is_empty() {
        req = req.header("X-ClickHouse-User", &c.user);
    }
    if !c.pass.is_empty() {
        req = req.header("X-ClickHouse-Key", &c.pass);
    }
    let resp = req.send().await.map_err(|e| format!("ClickHouse {}:{}: {e}", c.p.host, c.p.port))?;
    let status = resp.status();
    let summary = resp.headers().get("X-ClickHouse-Summary").and_then(|v| v.to_str().ok()).map(str::to_string);
    let body = resp.text().await.map_err(err)?;
    if !status.is_success() {
        return Err(body.trim().to_string());
    }
    let mut r = QueryResult::default();
    match serde_json::from_str::<Json>(&body) {
        Ok(j) if j.get("meta").is_some() => {
            r.columns = j["meta"].as_array().into_iter().flatten().map(|m| m["name"].as_str().unwrap_or("").to_string()).collect();
            let data = j["data"].as_array().cloned().unwrap_or_default();
            r.truncated = data.len() > MAX_ROWS || j.get("rows_before_limit_at_least").is_some_and(|v| v.as_u64().unwrap_or(0) > MAX_ROWS as u64);
            r.rows = data
                .into_iter()
                .take(MAX_ROWS)
                .map(|row| row.as_array().cloned().unwrap_or_default().into_iter().map(json_cell).collect())
                .collect();
            r.message = format!("{} строк", r.rows.len());
        }
        _ if body.trim().is_empty() => {
            let written = summary
                .and_then(|s| serde_json::from_str::<Json>(&s).ok())
                .and_then(|s| s["written_rows"].as_str().and_then(|v| v.parse::<u64>().ok()));
            r.affected = written;
            r.message = match written {
                Some(n) if n > 0 => format!("записано строк: {n}"),
                _ => "выполнено".into(),
            };
        }
        // the query had its own FORMAT: show the text as is
        _ => {
            r.columns = vec!["result".into()];
            r.rows = body.lines().take(MAX_ROWS).map(|l| vec![Some(l.to_string())]).collect();
            r.truncated = body.lines().count() > MAX_ROWS;
        }
    }
    Ok(r)
}

fn json_cell(v: Json) -> Option<String> {
    match v {
        Json::Null => None,
        Json::String(s) => Some(s),
        other => Some(other.to_string()),
    }
}

async fn ch_rows(c: &Ctx, q: &str, params: &[(&str, &str)]) -> Result<Vec<Vec<String>>, String> {
    let r = ch_query(c, q, None, params).await?;
    Ok(r.rows.into_iter().map(|row| row.into_iter().map(Option::unwrap_or_default).collect()).collect())
}

async fn ch_tree(c: &Ctx, path: &[String]) -> Result<Vec<Node>, String> {
    match path {
        [] => {
            let rows = ch_rows(c, "SELECT name FROM system.databases ORDER BY name IN ('system','INFORMATION_SCHEMA','information_schema'), name", &[]).await?;
            Ok(rows.into_iter().map(|r| node(&r[0], "database", "", false, None)).collect())
        }
        [db] => {
            let rows = ch_rows(
                c,
                "SELECT name, engine, toString(coalesce(total_rows, 0)) FROM system.tables WHERE database = {db:String} ORDER BY name",
                &[("db", db)],
            )
            .await?;
            Ok(rows
                .into_iter()
                .map(|r| {
                    let view = r[1].contains("View");
                    let detail = if view { r[1].clone() } else { format!("{} ~{} строк", r[1], r[2]) };
                    let sel = format!("SELECT * FROM {}.{} LIMIT 100", ch_ident(db), ch_ident(&r[0]));
                    node(&r[0], if view { "view" } else { "table" }, detail, false, Some(sel))
                })
                .collect())
        }
        [db, table] => {
            let rows = ch_rows(
                c,
                "SELECT name, type, toString(is_in_primary_key), toString(is_in_sorting_key) FROM system.columns \
                 WHERE database = {db:String} AND table = {t:String} ORDER BY position",
                &[("db", db), ("t", table)],
            )
            .await?;
            Ok(rows
                .into_iter()
                .map(|r| {
                    let mut d = r[1].clone();
                    if r[2] == "1" {
                        d += " · PK";
                    } else if r[3] == "1" {
                        d += " · ORDER BY";
                    }
                    node(&r[0], "column", d, true, None)
                })
                .collect())
        }
        _ => Ok(Vec::new()),
    }
}

// ---------- Redis ----------

fn redis_db(c: &Ctx, db: Option<&str>) -> i64 {
    db.or(Some(c.p.database.as_str()))
        .map(|d| d.trim_start_matches("db"))
        .and_then(|d| d.parse().ok())
        .unwrap_or(0)
}

async fn redis_connect(c: &Ctx, db: i64) -> Result<redis::aio::MultiplexedConnection, String> {
    let scheme = if c.p.tls == "off" { "redis" } else { "rediss" };
    let mut url = tauri::Url::parse(&format!("{scheme}://{}:{}/{db}", c.p.host, c.p.port)).map_err(err)?;
    if !c.user.is_empty() {
        let _ = url.set_username(&c.user);
    }
    if !c.pass.is_empty() {
        let _ = url.set_password(Some(&c.pass));
    }
    if c.p.tls == "require" {
        url.set_fragment(Some("insecure"));
    }
    let client = redis::Client::open(url.as_str()).map_err(err)?;
    tokio::time::timeout(CONNECT_TIMEOUT, client.get_multiplexed_async_connection())
        .await
        .map_err(|_| format!("Redis {}:{}: нет ответа за {} с", c.p.host, c.p.port, CONNECT_TIMEOUT.as_secs()))?
        .map_err(|e| format!("Redis {}:{}: {e}", c.p.host, c.p.port))
}

/// Shell-like split: spaces separate, "double" and 'single' quotes group, \" escapes inside "".
fn split_args(line: &str) -> Result<Vec<String>, String> {
    let (mut out, mut cur, mut any) = (Vec::new(), String::new(), false);
    let mut quote: Option<char> = None;
    let mut chars = line.chars();
    while let Some(ch) = chars.next() {
        match (quote, ch) {
            (Some('"'), '\\') => match chars.next() {
                Some('n') => cur.push('\n'),
                Some('t') => cur.push('\t'),
                Some(n) => cur.push(n),
                None => {}
            },
            (Some(q), _) if ch == q => quote = None,
            (Some(_), _) => cur.push(ch),
            (None, '"' | '\'') => {
                quote = Some(ch);
                any = true;
            }
            (None, c) if c.is_whitespace() => {
                if any || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                    any = false;
                }
            }
            (None, c) => cur.push(c),
        }
    }
    if quote.is_some() {
        return Err("незакрытая кавычка".into());
    }
    if any || !cur.is_empty() {
        out.push(cur);
    }
    Ok(out)
}

const REDIS_READ: &[&str] = &[
    "GET", "MGET", "STRLEN", "GETRANGE", "EXISTS", "TYPE", "TTL", "PTTL", "EXPIRETIME", "KEYS", "SCAN", "RANDOMKEY", "DBSIZE", "INFO", "PING",
    "ECHO", "TIME", "LASTSAVE", "HGET", "HMGET", "HGETALL", "HKEYS", "HVALS", "HLEN", "HEXISTS", "HSCAN", "HSTRLEN", "LRANGE", "LLEN", "LINDEX",
    "LPOS", "SMEMBERS", "SCARD", "SISMEMBER", "SMISMEMBER", "SSCAN", "SRANDMEMBER", "SINTER", "SUNION", "SDIFF", "ZRANGE", "ZRANGEBYSCORE",
    "ZREVRANGE", "ZREVRANGEBYSCORE", "ZRANGEBYLEX", "ZCARD", "ZSCORE", "ZMSCORE", "ZRANK", "ZREVRANK", "ZCOUNT", "ZSCAN", "XRANGE", "XREVRANGE",
    "XLEN", "XINFO", "XPENDING", "BITCOUNT", "GETBIT", "PFCOUNT", "OBJECT", "MEMORY", "SLOWLOG", "CLIENT", "CONFIG", "COMMAND", "ROLE",
    "SELECT", "GEOPOS", "GEODIST", "GEOSEARCH", "GEOHASH", "JSON.GET", "JSON.TYPE", "FT._LIST", "FT.INFO", "FT.SEARCH", "TS.RANGE", "TS.INFO",
];

fn redis_text(v: &redis::Value) -> String {
    use redis::Value as V;
    match v {
        V::Nil => "(nil)".into(),
        V::Int(i) => i.to_string(),
        V::BulkString(b) => String::from_utf8_lossy(b).into_owned(),
        V::SimpleString(s) => s.clone(),
        V::Okay => "OK".into(),
        V::Double(d) => d.to_string(),
        V::Boolean(b) => b.to_string(),
        V::VerbatimString { text, .. } => text.clone(),
        V::Array(a) | V::Set(a) => format!("[{}]", a.iter().map(redis_text).collect::<Vec<_>>().join(", ")),
        V::Map(m) => format!("{{{}}}", m.iter().map(|(k, v)| format!("{}: {}", redis_text(k), redis_text(v))).collect::<Vec<_>>().join(", ")),
        other => format!("{other:?}"),
    }
}

async fn redis_query(c: &Ctx, q: &str, db: Option<&str>) -> Result<QueryResult, String> {
    let lines: Vec<Vec<String>> = q
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("//"))
        .map(split_args)
        .collect::<Result<_, _>>()?;
    for args in &lines {
        let name = args[0].to_ascii_uppercase();
        let sub = args.get(1).map(|s| s.to_ascii_uppercase()).unwrap_or_default();
        let write_sub = matches!((name.as_str(), sub.as_str()), ("CONFIG", "SET" | "RESETSTAT" | "REWRITE") | ("CLIENT", "KILL" | "PAUSE") | ("SLOWLOG", "RESET") | ("MEMORY", "PURGE"));
        if c.p.readonly && (!REDIS_READ.contains(&name.as_str()) || write_sub) {
            return Err(format!("подключение только для чтения: {name} не выполняется"));
        }
        if matches!(name.as_str(), "SUBSCRIBE" | "PSUBSCRIBE" | "SSUBSCRIBE" | "MONITOR") {
            return Err(format!("{name} — потоковая команда, здесь не поддерживается; используйте redis-cli в терминале"));
        }
    }
    let mut con = redis_connect(c, redis_db(c, db)).await?;
    let mut r = QueryResult::default();
    let mut results = Vec::new();
    for args in &lines {
        let mut cmd = redis::cmd(&args[0]);
        for a in &args[1..] {
            cmd.arg(a);
        }
        let v: redis::Value = cmd.query_async(&mut con).await.map_err(|e| format!("{}: {e}", args.join(" ")))?;
        results.push((args.join(" "), v));
    }
    use redis::Value as V;
    match results.as_slice() {
        // one command: spread arrays / maps into rows
        [(cmdline, v)] => {
            let upper = cmdline.to_ascii_uppercase();
            match v {
                V::Map(m) => {
                    r.columns = vec!["поле".into(), "значение".into()];
                    r.rows = m.iter().map(|(k, v)| vec![Some(redis_text(k)), Some(redis_text(v))]).collect();
                }
                // RESP2 HGETALL / CONFIG GET / ... WITHSCORES: flat pairs
                V::Array(a) if a.len() % 2 == 0 && (upper.starts_with("HGETALL") || upper.starts_with("CONFIG GET") || upper.contains("WITHSCORES")) => {
                    r.columns = vec!["поле".into(), "значение".into()];
                    r.rows = a.chunks(2).map(|p| vec![Some(redis_text(&p[0])), Some(redis_text(&p[1]))]).collect();
                }
                V::Array(a) | V::Set(a) => {
                    r.columns = vec!["#".into(), "значение".into()];
                    r.rows = a.iter().enumerate().map(|(i, v)| vec![Some((i + 1).to_string()), Some(redis_text(v))]).collect();
                }
                // INFO and friends: one line per row reads better
                V::BulkString(_) | V::VerbatimString { .. } if redis_text(v).contains('\n') => {
                    r.columns = vec!["#".into(), "значение".into()];
                    r.rows = redis_text(v).lines().filter(|l| !l.trim().is_empty()).enumerate().map(|(i, l)| vec![Some((i + 1).to_string()), Some(l.trim_end().to_string())]).collect();
                }
                v => {
                    r.columns = vec!["значение".into()];
                    r.rows = vec![vec![Some(redis_text(v))]];
                }
            }
        }
        many => {
            r.columns = vec!["команда".into(), "результат".into()];
            r.rows = many.iter().map(|(c, v)| vec![Some(c.clone()), Some(redis_text(v))]).collect();
        }
    }
    r.truncated = r.rows.len() > MAX_ROWS;
    r.rows.truncate(MAX_ROWS);
    r.message = format!("{} строк", r.rows.len());
    Ok(r)
}

fn redis_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_graphic() && c != '"' && c != '\'' && c != '\\') {
        s.to_string()
    } else {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    }
}

async fn redis_tree(c: &Ctx, path: &[String]) -> Result<Vec<Node>, String> {
    match path {
        [] => {
            let mut con = redis_connect(c, 0).await?;
            let info: String = redis::cmd("INFO").arg("keyspace").query_async(&mut con).await.map_err(err)?;
            // db0:keys=12,expires=0,avg_ttl=0
            let mut dbs: Vec<(i64, String)> = info
                .lines()
                .filter_map(|l| {
                    let (name, rest) = l.split_once(':')?;
                    let n = name.strip_prefix("db")?.parse().ok()?;
                    let keys = rest.split(',').find_map(|kv| kv.strip_prefix("keys="))?.to_string();
                    Some((n, keys))
                })
                .collect();
            if !dbs.iter().any(|(n, _)| *n == 0) {
                dbs.insert(0, (0, "0".into()));
            }
            Ok(dbs.into_iter().map(|(n, k)| node(format!("db{n}"), "database", format!("{k} ключей"), false, None)).collect())
        }
        [db] => {
            let mut con = redis_connect(c, redis_db(c, Some(db))).await?;
            let mut keys: Vec<String> = Vec::new();
            let mut cursor: u64 = 0;
            loop {
                let (next, batch): (u64, Vec<String>) =
                    redis::cmd("SCAN").arg(cursor).arg("COUNT").arg(1000).query_async(&mut con).await.map_err(err)?;
                keys.extend(batch);
                cursor = next;
                if cursor == 0 || keys.len() >= 500 {
                    break;
                }
            }
            keys.sort();
            keys.truncate(500);
            let mut pipe = redis::pipe();
            for k in &keys {
                pipe.cmd("TYPE").arg(k);
            }
            let types: Vec<String> = if keys.is_empty() { Vec::new() } else { pipe.query_async(&mut con).await.map_err(err)? };
            let mut out: Vec<Node> = keys
                .iter()
                .zip(types)
                .map(|(k, t)| {
                    let q = redis_quote(k);
                    let read = match t.as_str() {
                        "hash" => format!("HGETALL {q}"),
                        "list" => format!("LRANGE {q} 0 99"),
                        "set" => format!("SMEMBERS {q}"),
                        "zset" => format!("ZRANGE {q} 0 99 WITHSCORES"),
                        "stream" => format!("XRANGE {q} - + COUNT 100"),
                        "ReJSON-RL" => format!("JSON.GET {q}"),
                        _ => format!("GET {q}"),
                    };
                    node(k, "key", t, true, Some(read))
                })
                .collect();
            if out.len() == 500 {
                out.push(node("…показаны первые 500 ключей; ищите командой SCAN 0 MATCH шаблон* COUNT 1000", "info", "", true, None));
            }
            Ok(out)
        }
        _ => Ok(Vec::new()),
    }
}

// ---------- MongoDB ----------

async fn mongo_client(c: &Ctx) -> Result<mongodb::Client, String> {
    let mut url = tauri::Url::parse(&format!("mongodb://{}:{}/", c.p.host, c.p.port)).map_err(err)?;
    if !c.user.is_empty() {
        let _ = url.set_username(&c.user);
        let _ = url.set_password((!c.pass.is_empty()).then_some(c.pass.as_str()));
    }
    let mut q = vec![
        format!("serverSelectionTimeoutMS={}", CONNECT_TIMEOUT.as_millis()),
        format!("connectTimeoutMS={}", CONNECT_TIMEOUT.as_millis()),
        "appName=OpsDeck".into(),
    ];
    if c.p.tls != "off" {
        q.push("tls=true".into());
        if c.p.tls == "require" {
            q.push("tlsAllowInvalidCertificates=true".into());
        }
    }
    let extra = c.p.options.trim().trim_start_matches('?');
    if !extra.is_empty() {
        q.push(extra.to_string());
    }
    // a single host without replicaSet: talk to it directly instead of discovering the set
    if !extra.contains("replicaSet") && !extra.contains("directConnection") {
        q.push("directConnection=true".into());
    }
    let uri = format!("{}?{}", url.as_str(), q.join("&"));
    mongodb::Client::with_uri_str(&uri).await.map_err(|e| format!("MongoDB {}:{}: {e}", c.p.host, c.p.port))
}

fn mongo_db(c: &Ctx, db: Option<&str>) -> String {
    db.map(str::to_string).filter(|d| !d.is_empty()).unwrap_or_else(|| if c.p.database.is_empty() { "admin".into() } else { c.p.database.clone() })
}

/// mongosh-isms → extended JSON: ObjectId("…") / ISODate("…") / NumberLong(…).
fn mongo_shellisms(s: &str) -> String {
    let mut out = s.to_string();
    for (from, to) in [("ObjectId(", "$oid"), ("ISODate(", "$date"), ("NumberLong(", "$numberLong"), ("NumberDecimal(", "$numberDecimal")] {
        while let Some(i) = out.find(from) {
            let start = i + from.len();
            let Some(end) = out[start..].find(')') else { break };
            let mut inner = out[start..start + end].trim().to_string();
            if !inner.starts_with('"') && !inner.starts_with('\'') {
                inner = format!("\"{inner}\"");
            }
            out.replace_range(i..start + end + 1, &format!("{{\"{to}\": {inner}}}"));
        }
    }
    out.replace("new Date(", "ISODate(")
}

fn parse_relaxed(s: &str) -> Result<Json, String> {
    json5::from_str::<Json>(&mongo_shellisms(s)).map_err(|e| format!("не разобрать JSON: {e}"))
}

fn to_doc(v: Json) -> Result<mongodb::bson::Document, String> {
    match mongodb::bson::Bson::try_from(v).map_err(err)? {
        mongodb::bson::Bson::Document(d) => Ok(d),
        _ => Err("ожидался объект { … }".into()),
    }
}

/// `name(args)` pieces of `db.coll.find({...}).sort({...}).limit(5)`; args are kept as source text.
fn mongo_calls(s: &str) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && (b[i] == b'.' || b[i].is_ascii_whitespace()) {
            i += 1;
        }
        let start = i;
        while i < b.len() && b[i] != b'(' {
            i += 1;
        }
        if i >= b.len() {
            return Err(format!("ожидалось «(» после «{}»", &s[start..]));
        }
        let name = s[start..i].trim().to_string();
        let (mut depth, mut quote, arg_start) = (0i32, 0u8, i + 1);
        while i < b.len() {
            let ch = b[i];
            if quote != 0 {
                if ch == b'\\' {
                    i += 1;
                } else if ch == quote {
                    quote = 0;
                }
            } else if ch == b'"' || ch == b'\'' {
                quote = ch;
            } else if ch == b'(' || ch == b'{' || ch == b'[' {
                depth += 1;
            } else if ch == b')' || ch == b'}' || ch == b']' {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            i += 1;
        }
        if i >= b.len() {
            return Err(format!("не закрыта скобка у {name}(…)"));
        }
        out.push((name, s[arg_start..i].to_string()));
        i += 1;
        while i < b.len() && (b[i] == b';' || b[i].is_ascii_whitespace()) {
            i += 1;
        }
    }
    Ok(out)
}

fn args_of(src: &str) -> Result<Vec<Json>, String> {
    if src.trim().is_empty() {
        return Ok(Vec::new());
    }
    match parse_relaxed(&format!("[{src}]"))? {
        Json::Array(a) => Ok(a),
        _ => Ok(Vec::new()),
    }
}

fn docs_result(docs: Vec<mongodb::bson::Document>, truncated: bool) -> QueryResult {
    let json: Vec<Json> = docs.into_iter().map(|d| mongodb::bson::Bson::Document(d).into_relaxed_extjson()).collect();
    let mut cols: Vec<String> = Vec::new();
    for d in &json {
        if let Some(o) = d.as_object() {
            for k in o.keys() {
                if !cols.contains(k) {
                    cols.push(k.clone());
                }
            }
        }
    }
    if let Some(i) = cols.iter().position(|c| c == "_id") {
        let id = cols.remove(i);
        cols.insert(0, id);
    }
    let rows = json
        .iter()
        .map(|d| cols.iter().map(|c| d.get(c).cloned().and_then(json_cell)).collect())
        .collect();
    QueryResult { message: format!("{} документов", json.len()), columns: cols, rows, truncated, docs: Some(json), ..Default::default() }
}

const MONGO_READ_CMDS: &[&str] = &[
    "ping", "buildinfo", "serverstatus", "dbstats", "collstats", "listcollections", "listdatabases", "hello", "ismaster", "count", "distinct",
    "find", "aggregate", "listindexes", "hostinfo", "getcmdlineopts", "replsetgetstatus", "connectionstatus", "currentop", "top", "explain",
];

async fn mongo_query(c: &Ctx, q: &str, db: Option<&str>) -> Result<QueryResult, String> {
    use futures::TryStreamExt;
    use mongodb::bson::{doc, Document};
    let client = mongo_client(c).await?;
    let dbname = mongo_db(c, db);
    let database = client.database(&dbname);
    let q = q.trim().trim_end_matches(';').trim();
    let lower = q.to_ascii_lowercase();
    let names = |xs: Vec<String>, col: &str| QueryResult {
        columns: vec![col.into()],
        message: format!("{} шт.", xs.len()),
        rows: xs.into_iter().map(|x| vec![Some(x)]).collect(),
        ..Default::default()
    };
    if lower == "show dbs" || lower == "show databases" {
        return Ok(names(client.list_database_names().await.map_err(err)?, "база"));
    }
    if lower == "show collections" || lower == "show tables" {
        let mut v = database.list_collection_names().await.map_err(err)?;
        v.sort();
        return Ok(names(v, "коллекция"));
    }
    // raw command document: { serverStatus: 1 }
    if q.starts_with('{') {
        let cmd = to_doc(parse_relaxed(q)?)?;
        let name = cmd.keys().next().map(|k| k.to_ascii_lowercase()).unwrap_or_default();
        if c.p.readonly && !MONGO_READ_CMDS.contains(&name.as_str()) {
            return Err(format!("подключение только для чтения: команда {name} не выполняется"));
        }
        let res = database.run_command(cmd).await.map_err(err)?;
        return Ok(docs_result(vec![res], false));
    }
    let rest = q.strip_prefix("db.").ok_or("ожидается db.<коллекция>.<метод>(…), { команда: 1 }, show dbs или show collections")?;
    // db.getCollection("name").find(...) or db.name.find(...)
    let (coll, chain) = if let Some(r) = rest.strip_prefix("getCollection(") {
        let end = r.find(')').ok_or("не закрыта скобка getCollection(")?;
        let name = r[..end].trim().trim_matches(|ch| ch == '"' || ch == '\'').to_string();
        (name, r[end + 1..].trim_start_matches('.').to_string())
    } else {
        let dot = rest.find('.').ok_or("ожидается db.<коллекция>.<метод>(…)")?;
        (rest[..dot].to_string(), rest[dot + 1..].to_string())
    };
    let calls = mongo_calls(&chain)?;
    let (method, margs) = calls.first().cloned().ok_or("нет метода")?;
    let args = args_of(&margs)?;
    let arg_doc = |i: usize| -> Result<Document, String> { args.get(i).cloned().map(to_doc).unwrap_or_else(|| Ok(Document::new())) };
    let collection = database.collection::<Document>(&coll);
    let write = matches!(
        method.as_str(),
        "insertOne" | "insertMany" | "updateOne" | "updateMany" | "replaceOne" | "deleteOne" | "deleteMany" | "drop" | "createIndex" | "dropIndex"
    );
    if c.p.readonly && write {
        return Err(format!("подключение только для чтения: {method} не выполняется"));
    }
    let affected = |n: u64, what: &str| QueryResult { affected: Some(n), message: format!("{what}: {n}"), ..Default::default() };
    match method.as_str() {
        "find" | "findOne" => {
            let mut find = collection.find(arg_doc(0)?);
            if let Some(p) = args.get(1).cloned() {
                find = find.projection(to_doc(p)?);
            }
            let mut limit = if method == "findOne" { 1 } else { MAX_ROWS as i64 };
            for (name, a) in &calls[1..] {
                let v = args_of(a)?.into_iter().next();
                match name.as_str() {
                    "sort" => find = find.sort(to_doc(v.ok_or("sort() без аргумента")?)?),
                    "limit" => limit = v.and_then(|v| v.as_i64()).unwrap_or(limit).clamp(1, MAX_ROWS as i64),
                    "skip" => find = find.skip(v.and_then(|v| v.as_u64()).unwrap_or(0)),
                    "projection" => find = find.projection(to_doc(v.ok_or("projection() без аргумента")?)?),
                    "pretty" | "toArray" => {}
                    other => return Err(format!("{other}() не поддерживается после find")),
                }
            }
            // one extra document tells whether there is more
            let cursor = find.limit(limit + 1).await.map_err(err)?;
            let mut docs: Vec<Document> = cursor.try_collect().await.map_err(err)?;
            let truncated = docs.len() as i64 > limit && limit == MAX_ROWS as i64;
            docs.truncate(limit as usize);
            Ok(docs_result(docs, truncated))
        }
        "aggregate" => {
            let pipeline: Vec<Document> = match args.first() {
                Some(Json::Array(a)) => a.iter().cloned().map(to_doc).collect::<Result<_, _>>()?,
                Some(_) => return Err("aggregate ждёт массив стадий: aggregate([ {...}, ... ])".into()),
                None => Vec::new(),
            };
            if c.p.readonly && pipeline.iter().any(|s| s.contains_key("$out") || s.contains_key("$merge")) {
                return Err("подключение только для чтения: $out / $merge не выполняются".into());
            }
            let cursor = collection.aggregate(pipeline).await.map_err(err)?;
            let mut docs: Vec<Document> = cursor.take(MAX_ROWS + 1).try_collect().await.map_err(err)?;
            let truncated = docs.len() > MAX_ROWS;
            docs.truncate(MAX_ROWS);
            Ok(docs_result(docs, truncated))
        }
        "countDocuments" | "count" => {
            let n = collection.count_documents(arg_doc(0)?).await.map_err(err)?;
            Ok(QueryResult { columns: vec!["count".into()], rows: vec![vec![Some(n.to_string())]], message: format!("{n}"), ..Default::default() })
        }
        "estimatedDocumentCount" => {
            let n = collection.estimated_document_count().await.map_err(err)?;
            Ok(QueryResult { columns: vec!["count".into()], rows: vec![vec![Some(n.to_string())]], message: format!("~{n}"), ..Default::default() })
        }
        "distinct" => {
            let field = args.first().and_then(Json::as_str).ok_or("distinct(\"поле\", {фильтр})")?.to_string();
            let vals = collection.distinct(&field, arg_doc(1)?).await.map_err(err)?;
            let rows: Vec<Vec<Option<String>>> = vals.into_iter().map(|v| vec![json_cell(v.into_relaxed_extjson())]).collect();
            Ok(QueryResult { message: format!("{} значений", rows.len()), columns: vec![field], rows, ..Default::default() })
        }
        "getIndexes" => {
            let res = database.run_command(doc! { "listIndexes": &coll }).await.map_err(err)?;
            let docs = res.get_document("cursor").ok().and_then(|c| c.get_array("firstBatch").ok()).cloned().unwrap_or_default();
            Ok(docs_result(docs.into_iter().filter_map(|b| b.as_document().cloned()).collect(), false))
        }
        "stats" => {
            let res = database.run_command(doc! { "collStats": &coll }).await.map_err(err)?;
            Ok(docs_result(vec![res], false))
        }
        "insertOne" => {
            collection.insert_one(arg_doc(0)?).await.map_err(err)?;
            Ok(affected(1, "вставлено"))
        }
        "insertMany" => {
            let docs: Vec<Document> = match args.first() {
                Some(Json::Array(a)) => a.iter().cloned().map(to_doc).collect::<Result<_, _>>()?,
                _ => return Err("insertMany ждёт массив документов".into()),
            };
            let n = collection.insert_many(docs).await.map_err(err)?.inserted_ids.len();
            Ok(affected(n as u64, "вставлено"))
        }
        "updateOne" | "updateMany" => {
            let (f, u) = (arg_doc(0)?, arg_doc(1)?);
            let res = if method == "updateOne" { collection.update_one(f, u).await } else { collection.update_many(f, u).await }.map_err(err)?;
            Ok(affected(res.modified_count, &format!("найдено {}, изменено", res.matched_count)))
        }
        "replaceOne" => {
            let res = collection.replace_one(arg_doc(0)?, arg_doc(1)?).await.map_err(err)?;
            Ok(affected(res.modified_count, "заменено"))
        }
        "deleteOne" | "deleteMany" => {
            let f = arg_doc(0)?;
            let res = if method == "deleteOne" { collection.delete_one(f).await } else { collection.delete_many(f).await }.map_err(err)?;
            Ok(affected(res.deleted_count, "удалено"))
        }
        other => Err(format!(
            "{other}() не поддерживается. Есть: find, findOne, aggregate, countDocuments, estimatedDocumentCount, distinct, getIndexes, stats, insertOne/Many, updateOne/Many, replaceOne, deleteOne/Many; или команда {{ … }}"
        )),
    }
}

fn mongo_coll_ref(name: &str) -> String {
    let ident = name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if ident {
        format!("db.{name}")
    } else {
        format!("db.getCollection({})", Json::String(name.to_string()))
    }
}

fn bson_type(v: &mongodb::bson::Bson) -> &'static str {
    use mongodb::bson::Bson as B;
    match v {
        B::Double(_) => "double",
        B::String(_) => "string",
        B::Array(_) => "array",
        B::Document(_) => "object",
        B::Boolean(_) => "bool",
        B::Null => "null",
        B::Int32(_) => "int",
        B::Int64(_) => "long",
        B::ObjectId(_) => "objectId",
        B::DateTime(_) => "date",
        B::Decimal128(_) => "decimal",
        B::Binary(_) => "binary",
        B::Timestamp(_) => "timestamp",
        _ => "other",
    }
}

async fn mongo_tree(c: &Ctx, path: &[String]) -> Result<Vec<Node>, String> {
    use futures::TryStreamExt;
    use mongodb::bson::{doc, Document};
    let client = mongo_client(c).await?;
    match path {
        [] => {
            let mut v = client.list_database_names().await.map_err(err)?;
            v.sort_by_key(|d| (["admin", "config", "local"].contains(&d.as_str()), d.clone()));
            Ok(v.into_iter().map(|d| node(d, "database", "", false, None)).collect())
        }
        [db] => {
            let mut v = client.database(db).list_collection_names().await.map_err(err)?;
            v.sort();
            Ok(v.into_iter().map(|n| { let q = format!("{}.find({{}}).limit(50)", mongo_coll_ref(&n)); node(n, "collection", "", false, Some(q)) }).collect())
        }
        [db, coll] => {
            let collection = client.database(db).collection::<Document>(coll);
            // fields: union over a sample of documents
            let sample: Vec<Document> = collection.find(doc! {}).limit(50).await.map_err(err)?.try_collect().await.map_err(err)?;
            let mut fields: Vec<(String, Vec<&'static str>)> = Vec::new();
            for d in &sample {
                for (k, v) in d {
                    let t = bson_type(v);
                    match fields.iter_mut().find(|(n, _)| n == k) {
                        Some((_, ts)) if !ts.contains(&t) => ts.push(t),
                        Some(_) => {}
                        None => fields.push((k.clone(), vec![t])),
                    }
                }
            }
            let mut out: Vec<Node> = fields.into_iter().map(|(k, ts)| node(k, "field", ts.join(" | "), true, None)).collect();
            if out.is_empty() {
                out.push(node("коллекция пуста", "info", "", true, None));
            }
            let idx = client.database(db).run_command(doc! { "listIndexes": coll }).await.map_err(err)?;
            let batch = idx.get_document("cursor").ok().and_then(|c| c.get_array("firstBatch").ok()).cloned().unwrap_or_default();
            for b in batch {
                if let Some(d) = b.as_document() {
                    let name = d.get_str("name").unwrap_or("").to_string();
                    let key = d.get_document("key").map(|k| k.to_string()).unwrap_or_default();
                    let uniq = if d.get_bool("unique").unwrap_or(false) { "UNIQUE " } else { "" };
                    out.push(node(name, "index", format!("{uniq}{key}"), true, None));
                }
            }
            Ok(out)
        }
        _ => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_statements_outside_quotes_and_comments() {
        assert_eq!(statements("select 1; select ';'; -- x;\n"), vec!["select 1", "select ';'"]);
        assert_eq!(statements("/* a; */ show tables"), vec!["show tables"]);
    }

    #[test]
    fn read_only_guard() {
        assert!(sql_read_only("SELECT * FROM t; show tables").is_ok());
        assert!(sql_read_only("with x as (select 1) select * from x").is_ok());
        assert!(sql_read_only("select 1; drop table t").is_err());
        assert!(sql_read_only("select * from t into outfile '/tmp/x'").is_err());
        assert!(sql_read_only("UPDATE t SET a = 1").is_err());
    }

    #[test]
    fn redis_args() {
        assert_eq!(split_args(r#"SET "a b" 'c d' e"#).unwrap(), vec!["SET", "a b", "c d", "e"]);
        assert_eq!(split_args(r#"GET """#).unwrap(), vec!["GET", ""]);
        assert!(split_args("GET \"x").is_err());
    }

    #[test]
    fn mongo_chain() {
        let calls = mongo_calls(r#"find({a: "x)"}, {b: 1}).sort({c: -1}).limit(5)"#).unwrap();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].0, "find");
        assert_eq!(calls[2], ("limit".into(), "5".into()));
        let args = args_of(&calls[0].1).unwrap();
        assert_eq!(args[0]["a"], "x)");
        let id = parse_relaxed(r#"{_id: ObjectId("65a1b2c3d4e5f60718293a4b")}"#).unwrap();
        assert!(to_doc(id).unwrap().get_object_id("_id").is_ok());
    }
}
