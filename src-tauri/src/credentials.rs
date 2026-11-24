//! Credential manager: logins (user name + password or private key) that sessions refer to
//! by id. Stored whole-file encrypted in `credentials.json` (`local_secrets`, like sessions)
//! and synced with the `sessions` category. Secrets never go to the frontend: it gets
//! [`CredentialSummary`], and [`apply`] fills them in right before connecting.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::models::{AuthType, ProtocolType, SessionConfig};
use crate::storage::Storage;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub id: String,
    pub name: String,
    /// Empty: the session's own user name is used.
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub auth_type: AuthType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
}

/// What the frontend sees: no secrets.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSummary {
    id: String,
    name: String,
    username: String,
    auth_type: AuthType,
    private_key_path: Option<String>,
    has_password: bool,
    has_passphrase: bool,
    /// Sessions using it (themselves or their jump host).
    used_by: usize,
}

impl CredentialSummary {
    fn new(c: &Credential, sessions: &[SessionConfig]) -> Self {
        let uses = |id: &Option<String>| id.as_deref() == Some(c.id.as_str());
        let set = |v: &Option<String>| v.as_deref().is_some_and(|v| !v.is_empty());
        Self {
            id: c.id.clone(),
            name: c.name.clone(),
            username: c.username.clone(),
            auth_type: c.auth_type.clone(),
            private_key_path: c.private_key_path.clone(),
            has_password: set(&c.password),
            has_passphrase: set(&c.passphrase),
            used_by: sessions
                .iter()
                .filter(|s| uses(&s.credential_id) || s.jump_host.as_ref().is_some_and(|j| uses(&j.credential_id)))
                .count(),
        }
    }
}

/// The form. A secret left out (`None`) keeps the saved one; an empty one clears it.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialInput {
    /// None: a new credential.
    #[serde(default)]
    id: Option<String>,
    name: String,
    #[serde(default)]
    username: String,
    auth_type: AuthType,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    private_key_path: Option<String>,
    #[serde(default)]
    passphrase: Option<String>,
}

// Error codes the frontend translates (`credentials.err.<code>`).
const NAME_REQUIRED: &str = "credentialNameRequired";
const NAME_TAKEN: &str = "credentialNameTaken";
const PASSWORD_REQUIRED: &str = "credentialPasswordRequired";
const KEY_REQUIRED: &str = "credentialKeyRequired";
const NOT_FOUND: &str = "credentialNotFound";

/// Add or update a credential in `list`; returns its id.
fn upsert(list: &mut Vec<Credential>, input: CredentialInput) -> Result<String, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err(NAME_REQUIRED.into());
    }
    let index = match &input.id {
        Some(id) => Some(list.iter().position(|c| &c.id == id).ok_or(NOT_FOUND)?),
        None => None,
    };
    if list.iter().enumerate().any(|(i, c)| Some(i) != index && c.name.to_lowercase() == name.to_lowercase()) {
        return Err(NAME_TAKEN.into());
    }
    let old = index.map(|i| &list[i]);
    let merge = |new: Option<String>, old: Option<String>| new.or(old).filter(|v| !v.is_empty());
    let mut next = Credential {
        id: input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        name,
        username: input.username.trim().to_string(),
        auth_type: input.auth_type,
        password: None,
        private_key_path: None,
        passphrase: None,
    };
    // Only the secrets of the chosen kind are kept.
    if next.auth_type == AuthType::PrivateKey {
        next.private_key_path = input.private_key_path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
        next.passphrase = merge(input.passphrase, old.and_then(|c| c.passphrase.clone()));
        if next.private_key_path.is_none() {
            return Err(KEY_REQUIRED.into());
        }
    } else {
        next.auth_type = AuthType::Password;
        next.password = merge(input.password, old.and_then(|c| c.password.clone()));
        if next.password.is_none() {
            return Err(PASSWORD_REQUIRED.into());
        }
    }
    let id = next.id.clone();
    match index {
        Some(i) => list[i] = next,
        None => list.push(next),
    }
    Ok(id)
}

fn takes_login(session: &SessionConfig) -> bool {
    matches!(session.protocol, ProtocolType::Ssh | ProtocolType::Rdp | ProtocolType::Vnc)
}

/// Whether connecting this session needs the credential store.
pub fn needed(session: &SessionConfig) -> bool {
    takes_login(session)
        && (session.credential_id.is_some() || session.jump_host.as_ref().is_some_and(|j| j.enabled && j.credential_id.is_some()))
}

fn find<'a>(list: &'a [Credential], id: &Option<String>) -> Result<Option<&'a Credential>, String> {
    match id.as_deref().filter(|id| !id.is_empty()) {
        None => Ok(None),
        Some(id) => list
            .iter()
            .find(|c| c.id == id)
            .map(Some)
            .ok_or_else(|| "会话使用的凭据不存在（可能已被删除），请在会话设置里重新选择".to_string()),
    }
}

/// Fill in the logins the session (and its jump host) refers to.
pub fn apply(session: &mut SessionConfig, list: &[Credential]) -> Result<(), String> {
    if !takes_login(session) {
        return Ok(());
    }
    if let Some(c) = find(list, &session.credential_id)? {
        let ssh = session.protocol == ProtocolType::Ssh;
        if !ssh && c.auth_type == AuthType::PrivateKey {
            return Err(format!("凭据「{}」是私钥，远程桌面只能使用密码凭据", c.name));
        }
        // A VNC user name selects macOS ARD authentication: that stays the session's choice.
        if !c.username.is_empty() && session.protocol != ProtocolType::Vnc {
            session.username = c.username.clone();
        }
        if ssh {
            session.auth_type = c.auth_type.clone();
        }
        session.password = c.password.clone();
        session.private_key_path = c.private_key_path.clone();
        session.passphrase = c.passphrase.clone();
    }
    if let Some(jump) = session.jump_host.as_mut().filter(|j| j.enabled) {
        if let Some(c) = find(list, &jump.credential_id)? {
            if !c.username.is_empty() {
                jump.username = c.username.clone();
            }
            jump.auth_type = c.auth_type.clone();
            jump.password = c.password.clone();
            jump.private_key_path = c.private_key_path.clone();
            jump.passphrase = c.passphrase.clone();
        }
    }
    Ok(())
}

fn set<T: PartialEq + Clone>(to: &mut T, from: &T) -> bool {
    let changed = to != from;
    if changed {
        *to = from.clone();
    }
    changed
}

/// Sessions keep a copy of the user name and kind (shown in lists, tabs and login prompts):
/// follow the credential, or with `None` (deleted) drop the reference. True when changed.
fn update_sessions(sessions: &mut [SessionConfig], id: &str, credential: Option<&Credential>) -> bool {
    let mut changed = false;
    for s in sessions {
        if s.credential_id.as_deref() == Some(id) {
            match credential {
                Some(c) => {
                    if !c.username.is_empty() && s.protocol != ProtocolType::Vnc {
                        changed |= set(&mut s.username, &c.username);
                    }
                    if s.protocol == ProtocolType::Ssh {
                        changed |= set(&mut s.auth_type, &c.auth_type);
                    }
                }
                None => changed |= s.credential_id.take().is_some(),
            }
        }
        if let Some(j) = s.jump_host.as_mut().filter(|j| j.credential_id.as_deref() == Some(id)) {
            match credential {
                Some(c) => {
                    if !c.username.is_empty() {
                        changed |= set(&mut j.username, &c.username);
                    }
                    changed |= set(&mut j.auth_type, &c.auth_type);
                }
                None => changed |= j.credential_id.take().is_some(),
            }
        }
    }
    changed
}

fn follow(storage: &Storage, id: &str, credential: Option<&Credential>) -> Result<bool, String> {
    let mut sessions = storage.load_sessions().map_err(|e| e.to_string())?;
    let changed = update_sessions(&mut sessions, id, credential);
    if changed {
        storage.save_sessions(&sessions).map_err(|e| e.to_string())?;
    }
    Ok(changed)
}

fn notify(app: &AppHandle, sessions_changed: bool) {
    let _ = app.emit("credentials-changed", ());
    if sessions_changed {
        let _ = app.emit("sessions-changed", ());
    }
}

#[tauri::command]
pub fn list_credentials(ctx: State<'_, crate::AppContext>) -> Result<Vec<CredentialSummary>, String> {
    let storage = ctx.storage.lock().map_err(|e| e.to_string())?;
    let sessions = storage.load_sessions().map_err(|e| e.to_string())?;
    let list = storage.load_credentials().map_err(|e| e.to_string())?;
    Ok(list.iter().map(|c| CredentialSummary::new(c, &sessions)).collect())
}

/// Returns the id.
#[tauri::command]
pub fn save_credential(app: AppHandle, ctx: State<'_, crate::AppContext>, credential: CredentialInput) -> Result<String, String> {
    let (id, changed) = {
        let storage = ctx.storage.lock().map_err(|e| e.to_string())?;
        let mut list = storage.load_credentials().map_err(|e| e.to_string())?;
        let id = upsert(&mut list, credential)?;
        storage.save_credentials(&list).map_err(|e| e.to_string())?;
        let changed = follow(&storage, &id, list.iter().find(|c| c.id == id))?;
        (id, changed)
    };
    notify(&app, changed);
    Ok(id)
}

/// Sessions using it go back to asking for the password.
#[tauri::command]
pub fn delete_credential(app: AppHandle, ctx: State<'_, crate::AppContext>, id: String) -> Result<(), String> {
    let changed = {
        let storage = ctx.storage.lock().map_err(|e| e.to_string())?;
        let mut list = storage.load_credentials().map_err(|e| e.to_string())?;
        let changed = follow(&storage, &id, None)?;
        list.retain(|c| c.id != id);
        storage.save_credentials(&list).map_err(|e| e.to_string())?;
        changed
    };
    notify(&app, changed);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input(v: serde_json::Value) -> CredentialInput {
        serde_json::from_value(v).unwrap()
    }

    fn store() -> Vec<Credential> {
        serde_json::from_value(json!([
            {"id": "p", "name": "Ops", "username": "ops", "authType": "password", "password": "pw"},
            {"id": "k", "name": "Key", "username": "git", "authType": "privatekey", "privateKeyPath": "~/.ssh/k", "passphrase": "pp"},
            {"id": "n", "name": "No user", "authType": "password", "password": "x"}
        ]))
        .unwrap()
    }

    fn session(v: serde_json::Value) -> SessionConfig {
        let mut base = json!({"id": "s", "label": "s", "protocol": "ssh", "host": "h", "port": 22, "username": "me"});
        base.as_object_mut().unwrap().extend(v.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn summaries_hold_no_secrets() {
        let users = [session(json!({"credentialId": "p"}))];
        let text = serde_json::to_string(&store().iter().map(|c| CredentialSummary::new(c, &users)).collect::<Vec<_>>()).unwrap();
        assert!(!text.contains("\"pw\"") && !text.contains("\"pp\""));
        assert_eq!(text.matches("\"usedBy\":1").count(), 1);
        assert!(text.contains("\"hasPassword\":true") && text.contains("\"hasPassphrase\":true"));
    }

    #[test]
    fn saving_keeps_secrets_left_out_and_drops_the_other_kind() {
        let mut list = store();
        upsert(&mut list, input(json!({"id": "p", "name": "Ops 2", "username": " root ", "authType": "password"}))).unwrap();
        assert_eq!((list[0].name.as_str(), list[0].username.as_str(), list[0].password.as_deref()), ("Ops 2", "root", Some("pw")));
        upsert(&mut list, input(json!({"id": "k", "name": "Key", "authType": "privatekey", "privateKeyPath": "k2", "passphrase": ""}))).unwrap();
        assert_eq!((list[1].private_key_path.as_deref(), list[1].passphrase.as_deref()), (Some("k2"), None));
        upsert(&mut list, input(json!({"id": "p", "name": "Ops", "authType": "privatekey", "privateKeyPath": "k"}))).unwrap();
        assert_eq!(list[0].password, None);
        let id = upsert(&mut list, input(json!({"name": "new", "authType": "password", "password": "q"}))).unwrap();
        assert_eq!(list.last().unwrap().id, id);
    }

    #[test]
    fn incomplete_or_duplicate_credentials_are_refused() {
        let mut list = store();
        let mut err = |v| upsert(&mut list, input(v)).unwrap_err();
        assert_eq!(err(json!({"name": " ", "authType": "password", "password": "x"})), NAME_REQUIRED);
        assert_eq!(err(json!({"name": "ops", "authType": "password", "password": "x"})), NAME_TAKEN);
        assert_eq!(err(json!({"name": "a", "authType": "password"})), PASSWORD_REQUIRED);
        assert_eq!(err(json!({"name": "a", "authType": "privatekey"})), KEY_REQUIRED);
        assert_eq!(err(json!({"id": "gone", "name": "a", "authType": "password", "password": "x"})), NOT_FOUND);
        assert_eq!(list.len(), 3);
    }

    #[test]
    fn fills_in_session_and_jump_host() {
        let mut s = session(json!({"credentialId": "k", "password": "stale", "jumpHost":
            {"enabled": true, "host": "j", "port": 22, "username": "x", "authType": "privatekey", "credentialId": "p"}}));
        assert!(needed(&s));
        apply(&mut s, &store()).unwrap();
        assert_eq!((s.username.as_str(), &s.auth_type), ("git", &AuthType::PrivateKey));
        assert_eq!((s.password, s.private_key_path.as_deref(), s.passphrase.as_deref()), (None, Some("~/.ssh/k"), Some("pp")));
        let j = s.jump_host.unwrap();
        assert_eq!((j.username.as_str(), &j.auth_type, j.password.as_deref()), ("ops", &AuthType::Password, Some("pw")));

        // No user name in the credential: the session's is used.
        let mut s = session(json!({"credentialId": "n"}));
        apply(&mut s, &store()).unwrap();
        assert_eq!((s.username.as_str(), s.password.as_deref()), ("me", Some("x")));

        // Nothing referenced: untouched.
        let mut s = session(json!({"password": "own"}));
        assert!(!needed(&s));
        apply(&mut s, &store()).unwrap();
        assert_eq!(s.password.as_deref(), Some("own"));
    }

    #[test]
    fn desktop_sessions_take_passwords_only() {
        let mut rdp = session(json!({"protocol": "rdp", "credentialId": "p"}));
        apply(&mut rdp, &store()).unwrap();
        assert_eq!((rdp.username.as_str(), rdp.password.as_deref()), ("ops", Some("pw")));
        let mut vnc = session(json!({"protocol": "vnc", "username": "", "credentialId": "p"}));
        apply(&mut vnc, &store()).unwrap();
        assert_eq!((vnc.username.as_str(), vnc.password.as_deref()), ("", Some("pw")));
        assert!(apply(&mut session(json!({"protocol": "rdp", "credentialId": "k"})), &store()).is_err());
    }

    #[test]
    fn missing_credentials_are_an_error() {
        assert!(apply(&mut session(json!({"credentialId": "gone"})), &store()).is_err());
        // Other protocols have no login to fill in.
        assert!(apply(&mut session(json!({"protocol": "telnet", "credentialId": "gone"})), &store()).is_ok());
    }

    #[test]
    fn sessions_follow_changes_and_deletion() {
        let mut list = vec![
            session(json!({"credentialId": "k"})),
            session(json!({})),
            session(json!({"jumpHost":
                {"enabled": true, "host": "j", "port": 22, "username": "x", "authType": "password", "credentialId": "k"}})),
        ];
        let store = store();
        assert!(update_sessions(&mut list, "k", Some(&store[1])));
        assert_eq!((list[0].username.as_str(), &list[0].auth_type), ("git", &AuthType::PrivateKey));
        assert_eq!(list[1].username, "me");
        assert_eq!(list[2].jump_host.as_ref().unwrap().username, "git");
        assert!(!update_sessions(&mut list, "k", Some(&store[1])));
        assert!(update_sessions(&mut list, "k", None));
        assert!(list.iter().all(|s| !needed(s)));
        assert!(!serde_json::to_string(&list).unwrap().contains("credentialId"));
    }
}
