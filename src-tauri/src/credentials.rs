//! Credential manager: logins (user name + password or private key) that sessions refer to
//! by id. Stored whole-file encrypted in `credentials.json` (`local_secrets`, like sessions)
//! and synced with the `sessions` category. Secrets never go to the frontend: it gets
//! [`CredentialSummary`], and [`apply`] fills them in right before connecting.
//!
//! A credential has one or both uses: a session login, and a OneKey (WindTerm's OneKeys): a
//! user name / password typed into a pane when its output shows a prompt matching the
//! OneKey's Expect rules (sudo, su, nested ssh, telnet login ...). The frontend matches the
//! rules; [`autofill_credential`] sends the secret straight to the pane.

use serde::{Deserialize, Serialize};
use serde_json::Value;
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
    /// Usable as a session login (older credentials all are).
    #[serde(default = "yes")]
    pub login: bool,
    /// Usable as a OneKey in terminal prompts.
    #[serde(default)]
    pub onekey: bool,
    #[serde(default)]
    pub expect: OnekeyExpect,
}

fn yes() -> bool {
    true
}

/// A prompt rule: the pane's text before the cursor must end with a match.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Expect {
    /// Empty: never matched (the value can still be sent by hand).
    pub pattern: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
}

impl Default for Expect {
    fn default() -> Self {
        Self { pattern: String::new(), regex: true, case_sensitive: false, whole_word: false }
    }
}

/// The OneKey's two rules, defaults as in WindTerm.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OnekeyExpect {
    pub username: Expect,
    pub password: Expect,
}

impl Default for OnekeyExpect {
    fn default() -> Self {
        Self {
            username: Expect { pattern: "username:|login:".into(), ..Expect::default() },
            password: Expect { pattern: r"Password:|Password for \S+:".into(), ..Expect::default() },
        }
    }
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
    login: bool,
    onekey: bool,
    expect: OnekeyExpect,
    /// Sessions using it (themselves, their jump host, or their OneKey list).
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
            login: c.login,
            onekey: c.onekey,
            expect: c.expect.clone(),
            used_by: sessions
                .iter()
                .filter(|s| {
                    uses(&s.credential_id)
                        || s.jump_host.as_ref().is_some_and(|j| uses(&j.credential_id))
                        || session_onekeys(s).any(|id| id == c.id)
                })
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
    #[serde(default = "yes")]
    login: bool,
    #[serde(default)]
    onekey: bool,
    #[serde(default)]
    expect: OnekeyExpect,
}

/// Ids of the OneKeys a session is limited to (frontend field `onekeys`, kept in `extra`).
fn session_onekeys(s: &SessionConfig) -> impl Iterator<Item = &str> {
    s.extra.get("onekeys").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str)
}

// Error codes the frontend translates (`credentials.err.<code>`).
const NAME_REQUIRED: &str = "credentialNameRequired";
const NAME_TAKEN: &str = "credentialNameTaken";
const PASSWORD_REQUIRED: &str = "credentialPasswordRequired";
const KEY_REQUIRED: &str = "credentialKeyRequired";
const NOT_FOUND: &str = "credentialNotFound";
const USAGE_REQUIRED: &str = "credentialUsageRequired";
const ONEKEY_PASSWORD: &str = "credentialOnekeyPassword";
const ONEKEY_EMPTY: &str = "credentialOnekeyEmpty";
const NOT_ONEKEY: &str = "credentialNotOnekey";
const FIELD_EMPTY: &str = "credentialFieldEmpty";
// Expect rules are JavaScript regular expressions (lookaround, backreferences ...) run by the
// frontend, which refuses to save one that does not compile: Rust's `regex` can't judge them.

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
    if !input.login && !input.onekey {
        return Err(USAGE_REQUIRED.into());
    }
    if input.onekey && input.auth_type == AuthType::PrivateKey {
        return Err(ONEKEY_PASSWORD.into());
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
        login: input.login,
        onekey: input.onekey,
        expect: input.expect,
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
        if next.login && next.password.is_none() {
            return Err(PASSWORD_REQUIRED.into());
        }
        // A OneKey alone may hold just a password (sudo) or just a user name (login:).
        if next.password.is_none() && next.username.is_empty() {
            return Err(ONEKEY_EMPTY.into());
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
    matches!(session.protocol, ProtocolType::Ssh | ProtocolType::Telnet | ProtocolType::Rdp | ProtocolType::Vnc)
}

/// Whether connecting this session needs the credential store.
pub fn needed(session: &SessionConfig) -> bool {
    takes_login(session)
        && (session.credential_id.is_some() || session.jump_host.as_ref().is_some_and(|j| j.enabled && j.credential_id.is_some()))
}

fn find<'a>(list: &'a [Credential], id: &Option<String>) -> Result<Option<&'a Credential>, String> {
    match id.as_deref().filter(|id| !id.is_empty()) {
        None => Ok(None),
        Some(id) => match list.iter().find(|c| c.id == id) {
            None => Err("会话使用的凭据不存在（可能已被删除），请在会话设置里重新选择".to_string()),
            Some(c) if !c.login => Err(format!("凭据「{}」不是登录凭据，请在凭据管理器里勾选“会话登录”或重新选择", c.name)),
            Some(c) => Ok(Some(c)),
        },
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
            return Err(format!("凭据「{}」是私钥，只有 SSH 能使用私钥凭据", c.name));
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
        if credential.is_none() {
            if let Some(Value::Array(ids)) = s.extra.get_mut("onekeys") {
                let before = ids.len();
                ids.retain(|v| v.as_str() != Some(id));
                changed |= ids.len() != before;
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

/// What a OneKey sends into a pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutofillField {
    Username,
    Password,
}

fn autofill_value(c: &Credential, field: AutofillField) -> Option<&str> {
    let value = match field {
        AutofillField::Username => Some(c.username.as_str()),
        AutofillField::Password => c.password.as_deref(),
    };
    value.filter(|v| !v.is_empty())
}

/// Type a OneKey's user name or password into a pane, followed by Enter. The secret goes
/// from the store to the connection: the page never sees it, it is not added to command
/// history and not broadcast to synced panes.
#[tauri::command]
pub fn autofill_credential(
    ctx: State<'_, crate::AppContext>,
    instance_id: String,
    credential_id: String,
    field: AutofillField,
) -> Result<(), String> {
    let line = {
        let storage = ctx.storage.lock().map_err(|e| e.to_string())?;
        let list = storage.load_credentials().map_err(|e| e.to_string())?;
        let c = list.iter().find(|c| c.id == credential_id).ok_or(NOT_FOUND)?;
        if !c.onekey {
            return Err(NOT_ONEKEY.into());
        }
        format!("{}\r", autofill_value(c, field).ok_or(FIELD_EMPTY)?)
    };
    if !crate::mcp::user_write_allowed(&instance_id, line.as_bytes()) {
        return Err("ai-locked".into());
    }
    ctx.connections.write(&instance_id, line.as_bytes()).map_err(|e| e.to_string())
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
        let mut telnet = session(json!({"protocol": "telnet", "port": 23, "credentialId": "p"}));
        apply(&mut telnet, &store()).unwrap();
        assert_eq!((telnet.username.as_str(), telnet.password.as_deref()), ("ops", Some("pw")));
        assert!(apply(&mut session(json!({"protocol": "telnet", "credentialId": "k"})), &store()).is_err());
    }

    #[test]
    fn older_credentials_are_logins_with_default_rules() {
        let c = &store()[0];
        assert!(c.login && !c.onekey);
        assert_eq!(c.expect, OnekeyExpect::default());
        assert_eq!(c.expect.password.pattern, r"Password:|Password for \S+:");
        let text = serde_json::to_string(&CredentialSummary::new(c, &[])).unwrap();
        assert!(text.contains("\"login\":true") && text.contains("\"onekey\":false") && !text.contains("\"pw\""));
    }

    #[test]
    fn onekeys_may_hold_only_a_password_or_a_user_name() {
        let mut list = store();
        let sudo = upsert(&mut list, input(json!({"name": "sudo", "authType": "password", "password": "s", "login": false, "onekey": true}))).unwrap();
        let user = upsert(&mut list, input(json!({"name": "tel", "username": "admin", "authType": "password", "login": false, "onekey": true}))).unwrap();
        let find = |id: &str| list.iter().find(|c| c.id == id).unwrap().clone();
        assert_eq!(autofill_value(&find(&sudo), AutofillField::Password), Some("s"));
        assert_eq!(autofill_value(&find(&sudo), AutofillField::Username), None);
        assert_eq!(autofill_value(&find(&user), AutofillField::Username), Some("admin"));
        assert_eq!(autofill_value(&find(&user), AutofillField::Password), None);

        let mut err = |v| upsert(&mut list, input(v)).unwrap_err();
        assert_eq!(err(json!({"name": "a", "authType": "password", "password": "x", "login": false})), USAGE_REQUIRED);
        assert_eq!(err(json!({"name": "a", "authType": "password", "login": false, "onekey": true})), ONEKEY_EMPTY);
        assert_eq!(err(json!({"name": "a", "authType": "privatekey", "privateKeyPath": "k", "onekey": true})), ONEKEY_PASSWORD);
        // JavaScript-only syntax (lookbehind) is kept as given; a rule left out gets its default.
        upsert(&mut list, input(json!({"name": "b", "authType": "password", "password": "x", "onekey": true,
            "expect": {"password": {"pattern": "(?<!new )password:", "regex": true}}}))).unwrap();
        let b = list.last().unwrap();
        assert_eq!(b.expect.password.pattern, "(?<!new )password:");
        assert_eq!(b.expect.username, OnekeyExpect::default().username);
    }

    #[test]
    fn sessions_cannot_log_in_with_a_onekey_only_credential() {
        let mut list = store();
        list[0].login = false;
        assert!(apply(&mut session(json!({"credentialId": "p"})), &list).is_err());
    }

    #[test]
    fn deleting_a_credential_drops_it_from_session_onekey_lists() {
        let mut list = vec![session(json!({"onekeys": ["p", "k"]}))];
        let store = store();
        assert_eq!(CredentialSummary::new(&store[0], &list).used_by, 1);
        assert!(!update_sessions(&mut list, "p", Some(&store[0])));
        assert!(update_sessions(&mut list, "p", None));
        assert_eq!(list[0].extra["onekeys"], json!(["k"]));
    }

    #[test]
    fn missing_credentials_are_an_error() {
        assert!(apply(&mut session(json!({"credentialId": "gone"})), &store()).is_err());
        // Other protocols have no login to fill in.
        assert!(apply(&mut session(json!({"protocol": "tcp", "credentialId": "gone"})), &store()).is_ok());
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
