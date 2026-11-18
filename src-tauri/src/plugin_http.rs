use reqwest::{header, redirect::Policy, Client, Method, Url};
use serde::Deserialize;
use serde_json::Value;
use std::{collections::HashMap, sync::{Arc, Mutex, OnceLock}, time::{Duration, Instant}};
use tauri::WebviewWindow;
use tokio::sync::{watch, Semaphore};

struct Grant {
    owner: String,
    plugin_id: String,
    credentials: bool,
    client: Client,
    origins: Mutex<Vec<String>>,
    request_network: bool,
    sessions: bool,
    revoked: watch::Sender<bool>,
    limit: Arc<Semaphore>,
    secrets: Mutex<HashMap<String, (String, String)>>,
}
impl Grant {
    fn has_origin(&self, value: &str) -> Result<bool, String> {
        Ok(self.origins.lock().map_err(|_| "Permission store unavailable")?.iter().any(|origin| origin == value))
    }
    fn add_origin(&self, value: &str) -> Result<(), String> {
        if !self.request_network { return Err("Dynamic network permission not declared".into()); }
        if *self.revoked.borrow() { return Err("Plugin permission revoked".into()); }
        if origin(value)? != value { return Err("Invalid plugin origin".into()); }
        let mut origins = self.origins.lock().map_err(|_| "Permission store unavailable")?;
        if !origins.iter().any(|origin| origin == value) {
            if origins.len() >= 16 { return Err("Plugin network origin limit reached".into()); }
            origins.push(value.into());
        }
        Ok(())
    }
}
fn grants() -> &'static Mutex<HashMap<String, Arc<Grant>>> {
    static GRANTS: OnceLock<Mutex<HashMap<String, Arc<Grant>>>> = OnceLock::new();
    GRANTS.get_or_init(Default::default)
}
fn grant(window: &WebviewWindow, capability: &str) -> Result<Arc<Grant>, String> {
    let map = grants().lock().map_err(|_| "Permission store unavailable")?;
    map.get(capability).filter(|grant| grant.owner == window.label()).cloned().ok_or_else(|| "Plugin permission revoked".into())
}
fn origin(value: &str) -> Result<String, String> {
    let url = Url::parse(value).map_err(|_| "Invalid URL")?;
    if url.scheme() != "https" || url.host().is_none() || url.host_str().is_some_and(|host| host.contains('*')) || !url.username().is_empty() || url.password().is_some() {
        return Err("Only HTTPS URLs without embedded credentials are allowed".into());
    }
    Ok(url.origin().ascii_serialization())
}

#[tauri::command]
pub fn plugin_grant(window: WebviewWindow, plugin_id: String, origins: Vec<String>, request_network: bool, sessions: bool, credentials: bool) -> Result<String, String> {
    validate_plugin_id(&plugin_id)?;
    if origins.len() > 16 || origins.iter().any(|value| origin(value).as_ref() != Ok(value)) { return Err("Invalid plugin origins".into()); }
    let capability = uuid::Uuid::new_v4().to_string();
    let (revoked, _) = watch::channel(false);
    let client = Client::builder().redirect(Policy::none()).timeout(Duration::from_secs(20)).build().map_err(|_| "HTTP client unavailable")?;
    grants().lock().map_err(|_| "Permission store unavailable")?.insert(capability.clone(), Arc::new(Grant {
        owner: window.label().into(), plugin_id, credentials, client, origins: Mutex::new(origins), request_network, sessions, revoked, limit: Arc::new(Semaphore::new(4)), secrets: Mutex::new(HashMap::new()),
    }));
    Ok(capability)
}
#[tauri::command]
pub fn plugin_allow_origin(window: WebviewWindow, capability: String, requested_origin: String) -> Result<(), String> {
    grant(&window, &capability)?.add_origin(&requested_origin)
}
#[tauri::command]
pub fn plugin_revoke(window: WebviewWindow, capability: String) -> Result<(), String> {
    let allowed = grant(&window, &capability)?;
    allowed.revoked.send_replace(true);
    grants().lock().map_err(|_| "Permission store unavailable")?.remove(&capability);
    allowed.secrets.lock().map_err(|_| "Secret store unavailable")?.clear();
    if let Ok(mut map) = staged().lock() { map.retain(|_, value| value.capability != capability); }
    Ok(())
}
#[tauri::command]
pub fn plugin_secret(window: WebviewWindow, capability: String, key: String, value: Option<String>, secret_origin: String) -> Result<(), String> {
    let allowed = grant(&window, &capability)?;
    if key.len() > 100 || value.as_ref().is_some_and(|value| value.len() > 16384) { return Err("Secret too large".into()); }
    if !allowed.has_origin(&secret_origin)? { return Err("Secret origin not granted".into()); }
    let mut secrets = allowed.secrets.lock().map_err(|_| "Secret store unavailable")?;
    match value { Some(value) => { if secrets.len() >= 32 && !secrets.contains_key(&key) { return Err("Secret limit reached".into()); } secrets.insert(key, (value, secret_origin)); }, None => { secrets.remove(&key); } }
    Ok(())
}
fn validate_plugin_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 96 || !value.as_bytes()[0].is_ascii_alphanumeric() || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)) { return Err("Invalid plugin ID".into()); }
    Ok(())
}
#[tauri::command]
pub fn plugin_credential(window: WebviewWindow, capability: String, key: String, credential_origin: String, operation: String, value: Option<String>) -> Result<Option<String>, String> {
    let allowed = grant(&window, &capability)?;
    if !allowed.credentials || *allowed.revoked.borrow() { return Err("Persistent credential permission not granted".into()); }
    if origin(&credential_origin)? != credential_origin || !allowed.has_origin(&credential_origin)? { return Err("Credential origin not granted".into()); }
    crate::plugin_credentials::access(&allowed.plugin_id, &credential_origin, &key, &operation, value.as_deref())
}
#[tauri::command]
pub fn plugin_forget_credentials(plugin_id: String) -> Result<(), String> {
    validate_plugin_id(&plugin_id)?;
    crate::plugin_credentials::forget(&plugin_id)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<Value>,
    bearer: Option<String>,
}
#[tauri::command]
pub async fn plugin_http(window: WebviewWindow, capability: String, request: HttpRequest) -> Result<Value, String> {
    if request.url.len() > 8192 { return Err("URL too large".into()); }
    let allowed = grant(&window, &capability)?;
    let target = origin(&request.url)?;
    if !allowed.has_origin(&target)? { return Err("Network origin not granted".into()); }
    let _permit = allowed.limit.clone().try_acquire_owned().map_err(|_| "Too many plugin requests")?;
    let method = match request.method.as_deref().unwrap_or("GET") { "GET" => Method::GET, "POST" => Method::POST, "PUT" => Method::PUT, "PATCH" => Method::PATCH, "DELETE" => Method::DELETE, _ => return Err("Unsupported HTTP method".into()) };
    let mut builder = allowed.client.request(method, &request.url).header(header::ACCEPT, "application/json");
    if let Some(headers) = request.headers {
        if headers.len() > 16 { return Err("Too many headers".into()); }
        for (name, value) in headers {
            if name.len() > 128 || value.len() > 8192 { return Err("Header too large".into()); }
            if ["host", "cookie", "authorization", "proxy-authorization", "connection", "content-length"].contains(&name.to_ascii_lowercase().as_str()) { return Err("Reserved HTTP header".into()); }
            builder = builder.header(name, value);
        }
    }
    if let Some(key) = request.bearer {
        let secrets = allowed.secrets.lock().map_err(|_| "Secret store unavailable")?;
        let (token, bound) = secrets.get(&key).ok_or("Missing credential: configure this plugin again")?;
        if *bound != target { return Err("Credential is bound to another origin".into()); }
        builder = builder.bearer_auth(token);
    }
    if let Some(body) = request.body {
        if body.to_string().len() > 65536 { return Err("Request too large".into()); }
        builder = builder.json(&body);
    }
    let mut revoked = allowed.revoked.subscribe();
    if *revoked.borrow() { return Err("Plugin permission revoked".into()); }
    let work = async {
        let mut response = builder.send().await.map_err(|_| "HTTPS request failed or timed out")?;
        if !response.status().is_success() { return Err(format!("HTTP {}", response.status().as_u16())); }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "Response interrupted")? {
            if bytes.len() + chunk.len() > 2 * 1024 * 1024 { return Err("Response exceeds 2 MiB".into()); }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| "Invalid JSON response".into())
    };
    tokio::select! { result = work => result, _ = revoked.changed() => Err("Plugin permission revoked".into()) }
}

struct Staged { owner: String, capability: String, password: String, created: Instant, host: String, port: u16, username: String }
fn staged() -> &'static Mutex<HashMap<String, Staged>> {
    static STAGED: OnceLock<Mutex<HashMap<String, Staged>>> = OnceLock::new();
    STAGED.get_or_init(Default::default)
}
#[tauri::command]
pub fn plugin_stage_ssh(window: WebviewWindow, capability: String, instance_id: String, secret_key: String, host: String, port: u16, username: String) -> Result<(), String> {
    let allowed = grant(&window, &capability)?;
    if !allowed.sessions { return Err("Opening sessions not granted".into()); }
    let secrets = allowed.secrets.lock().map_err(|_| "Secret store unavailable")?;
    let (password, _) = secrets.get(&secret_key).ok_or("Missing SSH credential")?;
    let mut map = staged().lock().map_err(|_| "Credential handoff unavailable")?;
    map.retain(|_, value| value.created.elapsed() < Duration::from_secs(30));
    if map.len() >= 32 { return Err("Too many pending connections".into()); }
    map.insert(instance_id.clone(), Staged { owner: window.label().into(), capability: capability.clone(), password: password.clone(), created: Instant::now(), host, port, username });
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        if let Ok(mut map) = staged().lock() { if map.get(&instance_id).is_some_and(|value| value.capability == capability) { map.remove(&instance_id); } }
    });
    Ok(())
}
pub fn take_ssh_password(owner: &str, instance_id: &str, host: &str, port: u16, username: &str) -> Option<String> {
    let mut map = staged().lock().ok()?;
    if !map.get(instance_id).is_some_and(|value| value.owner == owner && value.host == host && value.port == port && value.username == username && value.created.elapsed() < Duration::from_secs(30)) { return None; }
    map.remove(instance_id).map(|value| value.password)
}

pub fn forget_window(owner: &str) {
    if let Ok(mut map) = grants().lock() {
        map.retain(|_, value| {
            if value.owner != owner { return true; }
            value.revoked.send_replace(true);
            if let Ok(mut secrets) = value.secrets.lock() { secrets.clear(); }
            false
        });
    }
    if let Ok(mut map) = staged().lock() { map.retain(|_, value| value.owner != owner); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn origin_validation() {
        assert_eq!(origin("https://example.com:8443/path").unwrap(), "https://example.com:8443");
        for url in ["http://example.com", "https://user:pass@example.com", "https://*", "file:///tmp/test"] { assert!(origin(url).is_err()); }
    }
    fn test_grant(request_network: bool) -> Grant {
        let (revoked, _) = watch::channel(false);
        Grant {owner: "test".into(), plugin_id: "test".into(), credentials: false, client: Client::new(), origins: Mutex::new(Vec::new()), request_network, sessions: false, revoked, limit: Arc::new(Semaphore::new(4)), secrets: Mutex::new(HashMap::new())}
    }
    #[test]
    fn runtime_origins_require_opt_in_and_are_exact() {
        assert!(test_grant(false).add_origin("https://custom.example.com:9443").is_err());
        let allowed = test_grant(true);
        for invalid in ["http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com/", "https://*"] { assert!(allowed.add_origin(invalid).is_err()); }
        assert!(allowed.add_origin("https://custom.example.com:9443").is_ok());
        assert!(allowed.add_origin("https://custom.example.com:9443").is_ok());
        assert_eq!(allowed.origins.lock().unwrap().len(), 1);
        assert!(allowed.has_origin("https://custom.example.com:9443").unwrap());
        assert!(!allowed.has_origin("https://custom.example.com").unwrap());
        assert!(!allowed.has_origin("https://custom.example.com:9444").unwrap());
        assert!(!test_grant(true).has_origin("https://custom.example.com:9443").unwrap());
        allowed.revoked.send_replace(true);
        assert!(allowed.add_origin("https://other.example.com").is_err());
    }
    #[test]
    fn runtime_origin_count_is_bounded() {
        let allowed = test_grant(true);
        for index in 0..16 { allowed.add_origin(&format!("https://host{index}.example.com")).unwrap(); }
        assert!(allowed.add_origin("https://extra.example.com").is_err());
        assert!(allowed.add_origin("https://host0.example.com").is_ok());
    }
    fn stage_for_test(owner: &str, created: Instant) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        staged().lock().unwrap().insert(id.clone(), Staged {owner: owner.into(), capability: id.clone(), password: "test-password".into(), created, host: "gateway.example.com".into(), port: 2222, username: "user#account#asset".into()});
        id
    }
    #[test]
    fn credential_is_destination_bound_and_one_use() {
        let owner = uuid::Uuid::new_v4().to_string();
        let id = stage_for_test(&owner, Instant::now());
        assert!(take_ssh_password("another-window", &id, "gateway.example.com", 2222, "user#account#asset").is_none());
        assert!(take_ssh_password(&owner, &id, "another-host", 2222, "user#account#asset").is_none());
        assert!(take_ssh_password(&owner, &id, "gateway.example.com", 22, "user#account#asset").is_none());
        assert!(take_ssh_password(&owner, &id, "gateway.example.com", 2222, "another-user").is_none());
        assert_eq!(take_ssh_password(&owner, &id, "gateway.example.com", 2222, "user#account#asset"), Some("test-password".into()));
        assert!(take_ssh_password(&owner, &id, "gateway.example.com", 2222, "user#account#asset").is_none());
    }
    #[test]
    fn expired_and_closed_window_credentials_cannot_be_consumed() {
        let owner = uuid::Uuid::new_v4().to_string();
        let other_owner = uuid::Uuid::new_v4().to_string();
        let expired = stage_for_test(&owner, Instant::now() - Duration::from_secs(31));
        let closed = stage_for_test(&owner, Instant::now());
        let unrelated = stage_for_test(&other_owner, Instant::now());
        assert!(take_ssh_password(&owner, &expired, "gateway.example.com", 2222, "user#account#asset").is_none());
        forget_window(&owner);
        assert!(take_ssh_password(&owner, &closed, "gateway.example.com", 2222, "user#account#asset").is_none());
        assert!(take_ssh_password(&other_owner, &unrelated, "gateway.example.com", 2222, "user#account#asset").is_some());
        assert!(!staged().lock().unwrap().contains_key(&expired));
    }
}
