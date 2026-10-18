//! Dedicated fixed-file configuration transfer. Media credentials never enter this transport.
use reqwest::{header::{HeaderValue, AUTHORIZATION, ETAG, IF_MATCH, IF_NONE_MATCH}, Client, Url};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::{Arc, Mutex, OnceLock}, time::Duration};
use tauri::{ipc::Channel, State};

const MAX_BYTES: usize = 2 * 1024 * 1024;
const FILE_NAME: &str = "myjellyfinclient-servers-v1.json";

#[derive(Default, Clone)]
pub struct WebDavHttp {
    pending: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
}

#[derive(Deserialize)]
pub struct WebDavRequest {
    url: String,
    authorization: String,
    body: Option<String>,
    etag: Option<String>,
}

#[derive(Serialize)]
pub struct WebDavResponse {
    status: u16,
    etag: Option<String>,
    body: String,
}

fn permits_http(host: &str) -> bool {
    use std::net::{IpAddr, Ipv4Addr};
    let private_v4 = |ip: Ipv4Addr| ip.is_private() || ip.is_loopback() || ip.is_link_local();
    if host == "localhost" { return true; }
    match host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => private_v4(ip),
        Ok(IpAddr::V6(ip)) => ip.to_ipv4_mapped().map(private_v4)
            .unwrap_or_else(|| ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()),
        Err(_) => false,
    }
}

fn validate(request: &WebDavRequest) -> Result<(Url, HeaderValue), String> {
    let url = Url::parse(&request.url).map_err(|_| "WebDAV 地址无效")?;
    let local = url.host_str().is_some_and(permits_http);
    if (url.scheme() != "https" && !(url.scheme() == "http" && local)) || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
        || url.path().rsplit('/').next() != Some(FILE_NAME) {
        return Err("WebDAV 公网须使用 HTTPS（内网 IP 和本机允许 HTTP），并使用指定的配置文件路径".into());
    }
    if !request.authorization.starts_with("Basic ") || request.authorization.len() > 49152 {
        return Err("WebDAV 鉴权信息无效".into());
    }
    let mut auth = HeaderValue::from_str(&request.authorization).map_err(|_| "WebDAV 鉴权信息无效")?;
    auth.set_sensitive(true);
    if request.body.as_ref().is_some_and(|body| body.len() > MAX_BYTES) || (request.body.is_none() && request.etag.is_some()) {
        return Err("WebDAV 请求正文无效或过大".into());
    }
    if let Some(etag) = &request.etag {
        let bytes = etag.as_bytes();
        if bytes.len() < 3 || bytes.len() > 514 || bytes.first() != Some(&b'"') || bytes.last() != Some(&b'"')
            || !bytes[1..bytes.len()-1].iter().all(|byte| *byte == 0x21 || (0x23..=0x7e).contains(byte)) {
            return Err("WebDAV ETag 无效".into());
        }
    }
    Ok((url, auth))
}

fn client() -> Result<Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT.get_or_init(|| Client::builder().user_agent("MyJellyfinClient-WebDAV/1")
        .redirect(reqwest::redirect::Policy::none()).retry(reqwest::retry::never()).referer(false)
        .connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(30))
        .build().map_err(|_| "无法初始化 WebDAV 连接".to_owned())).clone()
}

async fn execute(request: WebDavRequest) -> Result<WebDavResponse, String> {
    let (url, auth) = validate(&request)?;
    let client = client()?;
    let mut builder = if let Some(body) = request.body.as_ref() {
        let builder = client.put(url).header("Content-Type", "application/json").body(body.clone());
        if let Some(etag) = &request.etag { builder.header(IF_MATCH, etag) } else { builder.header(IF_NONE_MATCH, "*") }
    } else { client.get(url) };
    builder = builder.header(AUTHORIZATION, auth).header("Accept", "application/json").header("Cache-Control", "no-store");
    let mut response = builder.send().await.map_err(network_error)?;
    let status = response.status().as_u16();
    if response.status().is_redirection() { return Err("WebDAV 不跟随重定向，请填写最终目录地址".into()); }
    let etag = response.headers().get(ETAG).and_then(|value| value.to_str().ok()).filter(|value| value.len() <= 514).map(str::to_owned);
    let mut result = WebDavResponse { status, etag, body: String::new() };
    // Never expose server error pages (which can echo credentials) to IPC/UI/logs.
    if request.body.is_some() || status != 200 { return Ok(result); }
    if response.content_length().is_some_and(|length| length > MAX_BYTES as u64) { return Err("WebDAV 配置文件过大".into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len() + chunk.len() > MAX_BYTES { return Err("WebDAV 配置文件过大".into()); }
        bytes.extend_from_slice(&chunk);
    }
    result.body = String::from_utf8(bytes).map_err(|_| "WebDAV 配置不是有效的 UTF-8 文件")?;
    Ok(result)
}

fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() { "WebDAV 请求超时；上传超时后请先下载核对云端结果" }
    else { "无法连接 WebDAV，请检查网络和服务器证书" }.into()
}

#[tauri::command]
pub fn start_webdav_request(request_id: String, request: WebDavRequest,
    on_response: Channel<Result<WebDavResponse, String>>, state: State<'_, WebDavHttp>) -> Result<(), String> {
    start_request(request_id, request, on_response, &state)
}

fn start_request(request_id: String, request: WebDavRequest,
    on_response: Channel<Result<WebDavResponse, String>>, state: &WebDavHttp) -> Result<(), String> {
    if request_id.is_empty() || request_id.len() > 64 { return Err("WebDAV 请求编号无效".into()); }
    validate(&request)?;
    let pending = state.pending.clone();
    let mut entries = pending.lock().map_err(|_| "WebDAV 请求状态不可用")?;
    if entries.len() >= 4 || entries.contains_key(&request_id) { return Err("WebDAV 请求过多".into()); }
    let completion = pending.clone(); let id = request_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let result = execute(request).await;
        if let Ok(mut entries) = completion.lock() { entries.remove(&id); }
        let _ = on_response.send(result);
    });
    entries.insert(request_id, handle);
    Ok(())
}

#[tauri::command]
pub fn cancel_webdav_request(request_id: String, state: State<'_, WebDavHttp>) { state.cancel(&request_id); }

impl WebDavHttp {
    fn cancel(&self, id: &str) {
        if let Ok(mut entries) = self.pending.lock() {
            if let Some(handle) = entries.remove(id) { handle.abort(); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::{Read, Write}, net::TcpListener, sync::mpsc, thread};

    fn fixture(responses: Vec<String>) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}/proxy/dav/{FILE_NAME}", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut buffer = [0; 4096];
                    let count = stream.read(&mut buffer).unwrap();
                    if count == 0 { break; }
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                        let length: usize = headers.lines().find_map(|line| line.strip_prefix("content-length: "))
                            .map(|value| value.parse().unwrap()).unwrap_or(0);
                        if bytes.len() >= end + 4 + length { break; }
                    }
                }
                tx.send(String::from_utf8(bytes).unwrap()).unwrap();
                if response == "SLOW" { thread::sleep(Duration::from_millis(200)); }
                else { let _ = stream.write_all(response.as_bytes()); }
            }
        });
        (address, rx, worker)
    }

    fn reply(status: &str, headers: &str, body: &str) -> String {
        format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n{body}", body.len())
    }

    fn request(url: &str) -> WebDavRequest {
        WebDavRequest { url: url.into(), authorization: "Basic Zml4dHVyZTpwYXNz".into(), body: None, etag: None }
    }

    #[test]
    fn webdav_validates_tls_fixed_file_headers_and_bounds() {
        let url = format!("https://fixture.invalid/dav/{FILE_NAME}");
        assert!(validate(&request(&url)).is_ok());
        for url in [format!("http://fixture.invalid/dav/{FILE_NAME}"), "https://fixture.invalid/other.json".into(),
            format!("https://user:pass@fixture.invalid/{FILE_NAME}"), format!("{url}?secret=value"), format!("{url}#fragment")] {
            assert!(validate(&request(&url)).is_err());
        }
        for etag in ["*", "W/\"weak\"", "unquoted", "\"bad\r\nvalue\"", "\"inner\"quote\""] {
            let mut row = request(&url); row.body = Some("encrypted".into()); row.etag = Some(etag.into());
            assert!(validate(&row).is_err());
        }
        let mut row = request(&url); row.body = Some("x".repeat(MAX_BYTES + 1));
        assert!(validate(&row).is_err());
        let mut row = request(&url); row.authorization = "Basic secret\r\nCookie: secret".into();
        assert!(validate(&row).is_err());
    }

    #[test]
    fn webdav_private_http_matches_browser_address_policy() {
        let matrix: serde_json::Value = serde_json::from_str(include_str!("../../scripts/fixtures/webdav-addresses.json")).unwrap();
        for (group, allowed) in [("allowed", true), ("denied", false)] {
            for address in matrix[group].as_array().unwrap() {
                let address = address.as_str().unwrap();
                let mut url = Url::parse(address).unwrap();
                url.set_path(&format!("{}/{FILE_NAME}", url.path().trim_end_matches('/')));
                assert_eq!(validate(&request(url.as_str())).is_ok(), allowed, "{address}");
            }
        }
    }

    #[test]
    fn webdav_real_http_get_put_conditions_and_errors() {
        tauri::async_runtime::block_on(async {
            let (url, received, worker) = fixture(vec![reply("200 OK", "ETag: \"one\"\r\n", "encrypted-file"),
                reply("201 Created", "", ""), reply("204 No Content", "", ""), reply("412 Precondition Failed", "", "secret-error-page")]);
            let response = execute(request(&url)).await.unwrap();
            assert_eq!(response.body, "encrypted-file"); assert_eq!(response.etag.as_deref(), Some("\"one\""));
            let get = received.recv().unwrap();
            assert!(get.starts_with(&format!("GET /proxy/dav/{FILE_NAME} HTTP/1.1")));
            assert!(get.to_ascii_lowercase().contains("authorization: basic zml4dhvyztpwyxnz"));
            assert!(!get.to_ascii_lowercase().contains("cookie:")); assert!(!get.to_ascii_lowercase().contains("x-emby"));
            let mut put = request(&url); put.body = Some("encrypted-update".into());
            assert_eq!(execute(put).await.unwrap().status, 201);
            let first = received.recv().unwrap().to_ascii_lowercase();
            assert!(first.contains("if-none-match: *")); assert!(first.ends_with("encrypted-update"));
            let mut put = request(&url); put.body = Some("encrypted-next".into()); put.etag = Some("\"one\"".into());
            assert_eq!(execute(put).await.unwrap().status, 204);
            assert!(received.recv().unwrap().to_ascii_lowercase().contains("if-match: \"one\""));
            let mut put = request(&url); put.body = Some("encrypted-next".into()); put.etag = Some("\"stale\"".into());
            let error = execute(put).await.unwrap(); assert_eq!(error.status, 412); assert!(error.body.is_empty());
            received.recv().unwrap(); worker.join().unwrap();
        });
    }

    #[test]
    fn webdav_refuses_redirects_and_oversized_responses_without_replay() {
        tauri::async_runtime::block_on(async {
            for response in [reply("302 Found", "Location: https://other.invalid/secret\r\n", ""),
                format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", MAX_BYTES + 1)] {
                let (url, received, worker) = fixture(vec![response]);
                assert!(execute(request(&url)).await.is_err()); received.recv().unwrap(); worker.join().unwrap();
                assert!(received.try_recv().is_err());
            }
        });
    }

    #[test]
    fn webdav_cancellation_aborts_running_task() {
        tauri::async_runtime::block_on(async {
            let (url, received, worker) = fixture(vec!["SLOW".into()]);
            let state = WebDavHttp::default();
            let task = tauri::async_runtime::spawn(async move { let _ = execute(request(&url)).await; });
            received.recv_timeout(Duration::from_secs(5)).unwrap();
            state.pending.lock().unwrap().insert("fixture".into(), task);
            state.cancel("fixture");
            assert!(state.pending.lock().unwrap().is_empty()); worker.join().unwrap();
        });
    }
}
