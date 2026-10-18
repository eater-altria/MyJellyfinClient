//! Bounded, cancellable desktop API requests; no cookies, credential logging or CORS bypass in the WebView.
use reqwest::{header::{HeaderMap, HeaderName, HeaderValue, LOCATION}, Client, Method, Url};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::{Arc, Mutex, OnceLock}, time::Duration};
use tauri::{ipc::Channel, State};

const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_PENDING: usize = 64;

#[derive(Default, Clone)]
pub struct MediaServerHttp {
    pending: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
    public_discovery: bool,
    reject_redirects: bool,
}

#[derive(Serialize)]
pub struct HttpResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
    url: String,
}

fn client() -> Result<Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT.get_or_init(|| Client::builder()
        .user_agent(crate::client_identity::http_user_agent())
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .referer(false)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build().map_err(|_| "无法初始化服务器网络连接".to_owned())).clone()
}

fn parse_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "服务器地址无效")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("服务器地址无效".into());
    }
    Ok(url)
}

fn validate(request: &HttpRequest) -> Result<(Url, Method, HeaderMap), String> {
    let url = parse_url(&request.url)?;
    let method = match request.method.as_str() {
        "GET" => Method::GET, "POST" => Method::POST, "DELETE" => Method::DELETE,
        _ => return Err("不支持的服务器请求方法".into()),
    };
    if request.body.as_ref().is_some_and(|body| body.len() > MAX_BODY_BYTES)
        || (method == Method::GET && request.body.is_some()) {
        return Err("服务器请求正文无效或过大".into());
    }
    let mut headers = HeaderMap::new();
    for (name, value) in &request.headers {
        let name = name.to_ascii_lowercase();
        if !matches!(name.as_str(), "authorization" | "x-emby-authorization" | "x-emby-token" | "accept" | "content-type" | "user-agent")
            || value.len() > 16384 {
            return Err("不支持的服务器请求头".into());
        }
        // Only the observed compatibility profile can override the shared UA.
        // This does not expose arbitrary native request headers to the WebView.
        if name == "user-agent" && value != "SenPlayer/6.2.2" {
            return Err("不支持的服务器客户端标识".into());
        }
        if request.public_discovery && (name == "x-emby-token"
            || value.to_ascii_lowercase().contains("token=") || value.to_ascii_lowercase().contains("userid=")) {
            return Err("公开探测不能携带账号凭据".into());
        }
        let mut value = HeaderValue::from_str(value).map_err(|_| "服务器请求头无效")?;
        value.set_sensitive(name.contains("authorization") || name == "x-emby-token");
        headers.insert(HeaderName::from_bytes(name.as_bytes()).map_err(|_| "服务器请求头无效")?, value);
    }
    if request.public_discovery && (method != Method::GET || url.query().is_some()
        || !url.path().trim_end_matches('/').to_ascii_lowercase().ends_with("/system/info/public")) {
        return Err("公开探测路径无效".into());
    }
    Ok((url, method, headers))
}

async fn execute(request: HttpRequest) -> Result<HttpResponse, String> {
    let (mut url, method, mut headers) = validate(&request)?;
    let client = client()?;
    // One deadline covers redirects and the entire response body.
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    for redirect_count in 0..=5 {
        let remaining = deadline.checked_duration_since(std::time::Instant::now()).ok_or("服务器请求超时")?;
        let mut builder = client.request(method.clone(), url.clone()).headers(headers.clone()).timeout(remaining);
        if let Some(body) = &request.body { builder = builder.body(body.clone()); }
        let mut response = builder.send().await.map_err(network_error)?;
        if matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            if request.reject_redirects || method != Method::GET || redirect_count == 5 {
                return Err("服务器请求重定向被拒绝".into());
            }
            let location = response.headers().get(LOCATION).and_then(|value| value.to_str().ok()).ok_or("服务器重定向无效")?;
            let next = url.join(location).map_err(|_| "服务器重定向无效")?;
            parse_url(next.as_str())?;
            if url.scheme() == "https" && next.scheme() != "https" { return Err("服务器重定向不能降低连接安全性".into()); }
            if next.origin() != url.origin() {
                if !request.public_discovery { return Err("服务器请求不能跨域转发凭据".into()); }
                // Public metadata may live elsewhere. Never forward even the
                // device identity to that host, or adopt it as the login route.
                headers.remove("authorization");
                headers.remove("x-emby-authorization");
            }
            url = next;
            continue;
        }
        let status = response.status().as_u16();
        let response_headers = ["content-type", "content-length", "server"].into_iter().filter_map(|name|
            response.headers().get(name).and_then(|value| value.to_str().ok()).map(|value| (name.to_owned(), value.to_owned()))).collect();
        if response.content_length().is_some_and(|size| size > MAX_RESPONSE_BYTES as u64) { return Err("服务器响应过大".into()); }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(network_error)? {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES { return Err("服务器响应过大".into()); }
            bytes.extend_from_slice(&chunk);
        }
        let body = String::from_utf8(bytes).map_err(|_| "服务器响应不是有效的 UTF-8 文本")?;
        return Ok(HttpResponse { status, headers: response_headers, body, url: url.to_string() });
    }
    Err("服务器重定向过多".into())
}

fn network_error(error: reqwest::Error) -> String {
    // reqwest error Display can include URLs and tokens. Never return it to IPC/logs.
    if error.is_timeout() { "服务器请求超时" } else { "无法连接服务器，请检查网络和服务器证书" }.into()
}

#[tauri::command]
pub fn start_media_server_request(request_id: String, request: HttpRequest,
    on_response: Channel<Result<HttpResponse, String>>, state: State<'_, MediaServerHttp>) -> Result<(), String> {
    start_request(request_id, request, on_response, &state)
}

fn start_request(request_id: String, request: HttpRequest,
    on_response: Channel<Result<HttpResponse, String>>, state: &MediaServerHttp) -> Result<(), String> {
    if request_id.len() > 64 || request_id.is_empty() { return Err("请求编号无效".into()); }
    validate(&request)?;
    let pending = state.pending.clone();
    let mut entries = pending.lock().map_err(|_| "服务器请求状态不可用")?;
    if entries.len() >= MAX_PENDING || entries.contains_key(&request_id) { return Err("服务器请求过多".into()); }
    let completion = pending.clone();
    let id = request_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let result = execute(request).await;
        if let Ok(mut entries) = completion.lock() { entries.remove(&id); }
        let _ = on_response.send(result);
    });
    entries.insert(request_id, handle);
    Ok(())
}

#[tauri::command]
pub fn cancel_media_server_request(request_id: String, state: State<'_, MediaServerHttp>) {
    state.cancel(&request_id);
}

impl MediaServerHttp {
    fn cancel(&self, request_id: &str) {
        if let Ok(mut entries) = self.pending.lock() {
            if let Some(handle) = entries.remove(request_id) { handle.abort(); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::{Read, Write}, net::TcpListener, sync::mpsc, thread};

    fn fixture(responses: Vec<String>) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
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
                        let length: usize = headers.lines().find_map(|line| line.strip_prefix("content-length: ")).map(|v| v.parse().unwrap()).unwrap_or(0);
                        if bytes.len() >= end + 4 + length { break; }
                    }
                }
                tx.send(String::from_utf8(bytes).unwrap()).unwrap();
                if response == "SLOW" { thread::sleep(Duration::from_millis(300)); }
                else { let _ = stream.write_all(response.as_bytes()); }
            }
        });
        (address, rx, worker)
    }

    fn response(status: &str, headers: &str, body: &str) -> String {
        format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{headers}\r\n{body}", body.len())
    }

    fn request(url: String) -> HttpRequest {
        HttpRequest { url, method: "GET".into(), headers: HashMap::from([
            ("Authorization".into(), "Emby Client=\"RodelPlayer\", Token=\"fixture-token\"".into()),
            ("X-Emby-Authorization".into(), "Emby Token=\"fixture-token\"".into()),
            ("X-Emby-Token".into(), "fixture-token".into()),
        ]), body: None, public_discovery: false, reject_redirects: false }
    }

    #[test]
    fn native_http_reads_without_cors_and_preserves_auth_status_and_post_body() {
        let (base, received, worker) = fixture(vec![response("200 OK", "", "{\"Items\":[]}"), response("401 Unauthorized", "", "denied"), response("204 No Content", "", "")]);
        let result = tauri::async_runtime::block_on(execute(request(format!("{base}/emby/Users/user/Views")))).unwrap();
        assert_eq!(result.status, 200);
        assert_eq!(result.body, "{\"Items\":[]}");
        let received_get = received.recv().unwrap();
        assert!(received_get.contains(&format!("user-agent: {}", crate::client_identity::http_user_agent())));
        assert!(received_get.contains("x-emby-token: fixture-token"));
        assert!(!received_get.to_ascii_lowercase().contains("origin:"));
        let mut login = request(format!("{base}/emby/Users/AuthenticateByName"));
        login.method = "POST".into(); login.body = Some("{\"Username\":\"fixture\",\"Pw\":\"test-password\"}".into());
        let result = tauri::async_runtime::block_on(execute(login)).unwrap();
        assert_eq!(result.status, 401);
        assert_eq!(result.body, "denied");
        assert!(received.recv().unwrap().ends_with("{\"Username\":\"fixture\",\"Pw\":\"test-password\"}"));
        assert_eq!(tauri::async_runtime::block_on(execute(request(base))).unwrap().status, 204);
        worker.join().unwrap();
    }

    #[test]
    fn senplayer_profile_overrides_only_api_ua_and_preserves_login() {
        let (base, received, worker) = fixture(vec![response("200 OK", "", "{}")]);
        let mut login = request(format!("{base}/proxy/emby/Users/AuthenticateByName"));
        login.method = "POST".into();
        login.headers = HashMap::from([
            ("User-Agent".into(), "SenPlayer/6.2.2".into()),
            ("X-Emby-Authorization".into(), "MediaBrowser Client=\"SenPlayer\", Version=\"6.2.2\"".into()),
        ]);
        login.body = Some("{\"Username\":\"fixture\",\"Pw\":\"test-password\",\"Password\":\"test-password\"}".into());
        assert!(tauri::async_runtime::block_on(execute(login)).is_ok());
        let wire = received.recv().unwrap();
        assert!(wire.starts_with("POST /proxy/emby/Users/AuthenticateByName "));
        assert!(wire.contains("user-agent: SenPlayer/6.2.2\r\n"));
        assert!(!wire.contains("\r\nauthorization:"));
        assert!(wire.contains("x-emby-authorization: MediaBrowser "));
        assert!(wire.ends_with("{\"Username\":\"fixture\",\"Pw\":\"test-password\",\"Password\":\"test-password\"}"));
        worker.join().unwrap();
        let mut invalid = request("https://example.test/Users/AuthenticateByName".into());
        invalid.headers.insert("User-Agent".into(), "arbitrary-client".into());
        assert!(validate(&invalid).is_err());
    }

    #[test]
    fn redirects_preserve_prefix_but_never_forward_credentials_or_replay_login() {
        let (target, target_received, target_worker) = fixture(vec![response("200 OK", "", "{}")]);
        let (base, received, worker) = fixture(vec![
            response("302 Found", "Location: /proxy/emby/System/Info/Public\r\n", ""),
            response("302 Found", &format!("Location: {target}/System/Info/Public\r\n"), ""),
            response("307 Temporary Redirect", &format!("Location: {target}/secret\r\n"), ""),
            response("307 Temporary Redirect", "Location: /login-again\r\n", ""),
        ]);
        let mut public = request(format!("{base}/System/Info/Public"));
        public.public_discovery = true;
        public.headers = HashMap::from([("X-Emby-Authorization".into(), "Emby Client=\"RodelPlayer\"".into())]);
        let result = tauri::async_runtime::block_on(execute(public)).unwrap();
        assert_eq!(result.url, format!("{target}/System/Info/Public"));
        assert!(received.recv().unwrap().contains("x-emby-authorization:"));
        assert!(received.recv().unwrap().starts_with("GET /proxy/emby/System/Info/Public "));
        assert!(!target_received.recv().unwrap().to_ascii_lowercase().contains("authorization:"));
        target_worker.join().unwrap();
        assert!(tauri::async_runtime::block_on(execute(request(base.clone()))).err().unwrap().contains("跨域"));
        let mut login = request(base); login.method = "POST".into(); login.body = Some("fixture-password".into());
        assert!(tauri::async_runtime::block_on(execute(login)).err().unwrap().contains("重定向"));
        worker.join().unwrap();
    }

    #[test]
    fn validation_and_response_limits_do_not_expose_secrets() {
        for url in ["file:///tmp/file", "https://user:secret@example.test", "ftp://example.test"] {
            assert!(validate(&request(url.into())).is_err());
        }
        let mut public = request("https://example.test/System/Info/Public".into()); public.public_discovery = true;
        assert!(validate(&public).is_err());
        let (base, _received, worker) = fixture(vec![format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", MAX_RESPONSE_BYTES + 1)]);
        assert_eq!(tauri::async_runtime::block_on(execute(request(base))).err().unwrap(), "服务器响应过大");
        worker.join().unwrap();
    }

    #[test]
    fn cancelling_native_request_releases_pending_work_and_suppresses_response() {
        let (base, received, worker) = fixture(vec!["SLOW".into()]);
        let state = MediaServerHttp::default();
        let (tx, rx) = mpsc::channel();
        let channel = Channel::new(move |_| { let _ = tx.send(()); Ok(()) });
        start_request("cancel-fixture".into(), request(base), channel, &state).unwrap();
        received.recv_timeout(Duration::from_secs(5)).unwrap();
        state.cancel("cancel-fixture");
        assert!(state.pending.lock().unwrap().is_empty());
        worker.join().unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
    }
}
