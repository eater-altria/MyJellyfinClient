//! Bounded, asynchronous playback diagnostics. Never persist raw media URLs or credentials.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{mpsc::{self, SyncSender}, Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use regex::Regex;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

fn redact(text: &str, secrets: &[String]) -> String {
    static URLS: OnceLock<Regex> = OnceLock::new();
    static FIELDS: OnceLock<Regex> = OnceLock::new();
    static BEARER: OnceLock<Regex> = OnceLock::new();
    let mut text = text.to_owned();
    for secret in secrets.iter().filter(|secret| !secret.is_empty()) { text = text.replace(secret, "[redacted]"); }
    text = URLS.get_or_init(|| Regex::new(r#"(?i)https?://[^\s"'<>]+"#).unwrap()).replace_all(&text, "[URL redacted]").into_owned();
    text = BEARER.get_or_init(|| Regex::new(r#"(?i)\b(Bearer|Basic)\s+[^\s"'<>,]+"#).unwrap()).replace_all(&text, "$1 [redacted]").into_owned();
    FIELDS.get_or_init(|| Regex::new(r#"(?i)(["']?(?:authorization|x-emby-token|cookie|set-cookie|api[_-]?key|access[_-]?token|token|password|pwd|pw|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)"#).unwrap())
        .replace_all(&text, "$1[redacted]").chars().take(1024).collect()
}

fn sanitize(value: &Value, secrets: &[String], depth: usize) -> Value {
    static SENSITIVE: OnceLock<Regex> = OnceLock::new();
    if depth > 6 { return json!("[truncated]"); }
    match value {
        Value::String(text) => json!(redact(text, secrets)),
        Value::Array(entries) => entries.iter().take(32).map(|entry| sanitize(entry, secrets, depth + 1)).collect(),
        Value::Object(entries) => entries.iter().take(48).map(|(key, value)| {
            let sensitive = SENSITIVE.get_or_init(|| Regex::new(r"(?i)token|password|authorization|cookie|secret|api[_-]?key|^pw$").unwrap()).is_match(key);
            (key.chars().take(128).collect::<String>(), if sensitive { json!("[redacted]") } else { sanitize(value, secrets, depth + 1) })
        }).collect(),
        other => other.clone(),
    }
}

fn append_entry(path: &Path, entry: &Value, max_bytes: u64) -> std::io::Result<()> {
    if std::fs::metadata(path).map(|metadata| metadata.len() >= max_bytes).unwrap_or(false) {
        let backup = path.with_file_name("playback.log.1");
        if backup.exists() { std::fs::remove_file(&backup)?; }
        std::fs::rename(path, backup)?;
    }
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{entry}")?;
    file.flush()
}

pub struct PlaybackDiagnostics {
    sender: Option<SyncSender<Value>>,
    path: PathBuf,
    error: Arc<Mutex<Option<String>>>,
}

impl PlaybackDiagnostics {
    pub fn new(app: &AppHandle) -> Self {
        let primary = std::env::var_os("MJC_WEBVIEW_DATA").map(PathBuf::from)
            .or_else(|| app.path().app_local_data_dir().ok());
        let fallback = app.path().app_cache_dir().ok();
        let mut path = PathBuf::new();
        let mut failure = Some("无法确定诊断日志目录".to_owned());
        for root in primary.into_iter().chain(fallback) {
            path = root.join("logs/playback.log");
            let result = std::fs::create_dir_all(path.parent().unwrap())
                .and_then(|_| std::fs::OpenOptions::new().create(true).append(true).open(&path).map(|_| ()));
            match result { Ok(()) => { failure = None; break; }, Err(error) => failure = Some(error.to_string()) }
        }
        let error = Arc::new(Mutex::new(failure));
        let sender = if error.lock().unwrap().is_none() {
            let (sender, receiver) = mpsc::sync_channel::<Value>(128);
            let writer_path = path.clone();
            let writer_error = error.clone();
            std::thread::spawn(move || for entry in receiver {
                if let Err(failure) = append_entry(&writer_path, &entry, MAX_LOG_BYTES) {
                    *writer_error.lock().unwrap() = Some(failure.to_string());
                }
            });
            Some(sender)
        } else { None };
        Self { sender, path, error }
    }

    fn record(&self, trace: &str, stage: &str, details: Value, secrets: &[String]) {
        if let Some(sender) = &self.sender {
            enqueue(sender, trace, stage, details, secrets);
        }
    }
}

fn enqueue(sender: &SyncSender<Value>, trace: &str, stage: &str, details: Value, secrets: &[String]) {
    let entry = json!({
        "timestampMs": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "trace": trace.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect::<String>(),
        "stage": stage.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')).take(64).collect::<String>(),
        "details": sanitize(&details, secrets, 0),
    });
    // Logging must not block player IPC or the window's UI thread.
    let _ = sender.try_send(entry);
}

#[derive(Clone)]
pub struct PlaybackTrace {
    sender: Option<SyncSender<Value>>,
    pub id: String,
    secrets: Arc<Vec<String>>,
}

impl PlaybackTrace {
    pub fn new(app: &AppHandle, id: String, url: &str, headers: Option<&std::collections::HashMap<String, String>>) -> Self {
        let mut secrets = Vec::new();
        if let Ok(url) = tauri::Url::parse(url) {
            for (key, value) in url.query_pairs() {
                if key.to_ascii_lowercase().contains("token") || matches!(key.to_ascii_lowercase().as_str(), "api_key" | "apikey" | "password") {
                    secrets.push(value.into_owned());
                }
            }
            if let Some(password) = url.password() { secrets.push(password.to_owned()); }
        }
        if let Some(headers) = headers {
            for (key, value) in headers {
                if matches!(key.to_ascii_lowercase().as_str(), "authorization" | "x-emby-token" | "cookie") { secrets.push(value.clone()); }
            }
        }
        Self { sender: app.state::<PlaybackDiagnostics>().sender.clone(), id, secrets: Arc::new(secrets) }
    }
    pub fn record(&self, stage: &str, details: Value) {
        if let Some(sender) = &self.sender {
            enqueue(sender, &self.id, stage, details, &self.secrets);
        }
    }
    #[cfg(test)]
    pub(crate) fn fixture(sender: SyncSender<Value>, secrets: Vec<String>) -> Self {
        Self { sender: Some(sender), id: "fixture-playback".into(), secrets: Arc::new(secrets) }
    }
}

#[tauri::command]
pub fn record_playback_diagnostic(state: tauri::State<'_, PlaybackDiagnostics>, trace_id: String, stage: String, details: Value) {
    state.record(&trace_id, &stage, details, &[]);
}

#[tauri::command]
pub fn get_playback_log_path(state: tauri::State<'_, PlaybackDiagnostics>) -> Result<String, String> {
    if let Some(error) = state.error.lock().unwrap().as_ref() { return Err(format!("无法写入诊断日志: {error}")); }
    Ok(state.path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redacts_credentials_urls_and_nested_values() {
        let secret = "fixture-access-token".to_owned();
        let value = json!({"url":"https://user:password@fixture.invalid/stream?api_key=fixture-access-token",
            "headers":{"Authorization":"Bearer hidden", "Cookie":"session=hidden"},
            "message":"HTTP 522 token=hidden api_key=hidden password=hidden Bearer hidden; echoed fixture-access-token",
            "status":522, "nested":[{"AccessToken":"hidden"}]});
        let safe = sanitize(&value, &[secret], 0).to_string();
        for sensitive in ["fixture.invalid", "fixture-access-token", "hidden", "user:password"] { assert!(!safe.contains(sensitive), "{safe}"); }
        assert!(safe.contains("522"));
        assert!(safe.contains("redacted"));
    }
    #[test]
    fn rotates_and_writes_parseable_json_lines() {
        let directory = std::env::temp_dir().join(format!("mjc-diagnostic-test-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("playback.log");
        append_entry(&path, &json!({"stage":"first"}), 1).unwrap();
        append_entry(&path, &json!({"stage":"second"}), 1).unwrap();
        assert!(directory.join("playback.log.1").exists());
        let line = std::fs::read_to_string(path).unwrap();
        assert_eq!(serde_json::from_str::<Value>(line.trim()).unwrap()["stage"], "second");
        assert_eq!(directory.parent(), Some(std::env::temp_dir().as_path()));
        assert!(directory.file_name().unwrap().to_string_lossy().starts_with("mjc-diagnostic-test-"));
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn a_full_log_queue_does_not_block_playback() {
        let (sender, receiver) = mpsc::sync_channel(1);
        enqueue(&sender, "fixture", "playback.first", json!({"password":"hidden"}), &[]);
        let started = std::time::Instant::now();
        for _ in 0..100 { enqueue(&sender, "fixture", "playback.dropped", json!({}), &[]); }
        assert!(started.elapsed() < std::time::Duration::from_millis(500));
        let entry = receiver.recv().unwrap();
        assert_eq!(entry["stage"], "playback.first");
        assert_eq!(entry["details"]["password"], "[redacted]");
    }
}
