/// Every plugin credential's target name starts with this.
pub const ROOT: &str = "Nexterm/Plugins/";
/// Largest value a credential holds.
pub const MAX_VALUE: usize = 2560;

fn prefix(plugin_id: &str) -> String { format!("{ROOT}{plugin_id}/") }

fn target(plugin_id: &str, origin: &str, key: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, format!("{origin}\0{key}").as_bytes());
    let hash: String = digest.as_ref().iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}{hash}", prefix(plugin_id))
}

pub fn access(plugin_id: &str, origin: &str, key: &str, operation: &str, value: Option<&str>) -> Result<Option<String>, String> {
    if key.is_empty() || key.len() > 100 || value.is_some_and(|value| value.len() > MAX_VALUE) { return Err("Invalid persistent credential".into()); }
    system::access(&target(plugin_id, origin, key), operation, value)
}
pub fn forget(plugin_id: &str) -> Result<(), String> { system::forget(&prefix(plugin_id)) }

/// Is `target` the name of a plugin credential (`Nexterm/Plugins/<plugin id>/<64 hex>`)?
pub fn valid_target(target: &str) -> bool {
    let Some((plugin, hash)) = target.strip_prefix(ROOT).and_then(|rest| rest.split_once('/')) else { return false };
    !plugin.is_empty() && plugin.len() <= 96 && plugin.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

/// All plugin credentials on this computer as (target, value), sorted by target (for sync).
pub fn list_all() -> Result<Vec<(String, String)>, String> {
    let mut out: Vec<(String, String)> = system::list(ROOT)?.into_iter().filter(|(t, _)| valid_target(t)).collect();
    out.sort();
    Ok(out)
}
/// Write a credential by its target name (sync).
pub fn put(target: &str, value: &str) -> Result<(), String> {
    if !valid_target(target) || value.len() > MAX_VALUE { return Err("Invalid persistent credential".into()); }
    system::access(target, "set", Some(value)).map(|_| ())
}
/// Delete a credential by its target name (sync).
pub fn remove(target: &str) -> Result<(), String> {
    if !valid_target(target) { return Err("Invalid persistent credential".into()); }
    system::access(target, "delete", None).map(|_| ())
}

#[cfg(windows)]
mod system {
    use windows_sys::Win32::{Foundation::{GetLastError, ERROR_NOT_FOUND}, Security::Credentials::*};
    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }
    fn failure() -> String { format!("Windows credential store unavailable ({})", unsafe { GetLastError() }) }
    struct Allocation(*mut std::ffi::c_void);
    impl Drop for Allocation { fn drop(&mut self) { unsafe { CredFree(self.0); } } }

    pub fn access(target: &str, operation: &str, value: Option<&str>) -> Result<Option<String>, String> {
        let target = wide(target);
        unsafe {
            match operation {
                "get" => {
                    let mut credential = std::ptr::null_mut();
                    if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) == 0 {
                        return if GetLastError() == ERROR_NOT_FOUND { Ok(None) } else { Err(failure()) };
                    }
                    let _allocation = Allocation(credential.cast());
                    let credential = &*credential;
                    if credential.CredentialBlobSize == 0 { return Ok(Some(String::new())); }
                    if credential.CredentialBlob.is_null() || credential.CredentialBlobSize > 2560 { return Err("Invalid saved credential".into()); }
                    let bytes = std::slice::from_raw_parts(credential.CredentialBlob, credential.CredentialBlobSize as usize);
                    String::from_utf8(bytes.to_vec()).map(Some).map_err(|_| "Invalid saved credential".into())
                }
                "set" => {
                    let mut bytes = value.ok_or("Missing credential value")?.as_bytes().to_vec();
                    let mut credential: CREDENTIALW = std::mem::zeroed();
                    credential.Type = CRED_TYPE_GENERIC;
                    credential.TargetName = target.as_ptr() as *mut u16;
                    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
                    credential.CredentialBlobSize = bytes.len() as u32;
                    credential.CredentialBlob = bytes.as_mut_ptr();
                    let result = CredWriteW(&credential, 0);
                    bytes.fill(0);
                    if result == 0 { Err(failure()) } else { Ok(None) }
                }
                "delete" => {
                    if CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) == 0 && GetLastError() != ERROR_NOT_FOUND { Err(failure()) } else { Ok(None) }
                }
                _ => Err("Unknown credential operation".into()),
            }
        }
    }
    pub fn list(prefix: &str) -> Result<Vec<(String, String)>, String> {
        let filter = wide(&format!("{prefix}*"));
        let mut out = Vec::new();
        unsafe {
            let mut count = 0;
            let mut credentials = std::ptr::null_mut();
            if CredEnumerateW(filter.as_ptr(), 0, &mut count, &mut credentials) == 0 {
                return if GetLastError() == ERROR_NOT_FOUND { Ok(out) } else { Err(failure()) };
            }
            let _allocation = Allocation(credentials.cast());
            for credential in std::slice::from_raw_parts(credentials, count as usize) {
                let credential = &**credential;
                if credential.Type != CRED_TYPE_GENERIC || credential.TargetName.is_null() { continue; }
                let mut len = 0;
                while *credential.TargetName.add(len) != 0 { len += 1; }
                let target = String::from_utf16_lossy(std::slice::from_raw_parts(credential.TargetName, len));
                let size = credential.CredentialBlobSize as usize;
                if size > super::MAX_VALUE || (size > 0 && credential.CredentialBlob.is_null()) { continue; }
                let bytes = if size == 0 { &[][..] } else { std::slice::from_raw_parts(credential.CredentialBlob, size) };
                if let Ok(value) = String::from_utf8(bytes.to_vec()) { out.push((target, value)); }
            }
        }
        Ok(out)
    }
    pub fn forget(prefix: &str) -> Result<(), String> {
        let filter = wide(&format!("{prefix}*"));
        unsafe {
            let mut count = 0;
            let mut credentials = std::ptr::null_mut();
            if CredEnumerateW(filter.as_ptr(), 0, &mut count, &mut credentials) == 0 {
                return if GetLastError() == ERROR_NOT_FOUND { Ok(()) } else { Err(failure()) };
            }
            let _allocation = Allocation(credentials.cast());
            for credential in std::slice::from_raw_parts(credentials, count as usize) {
                if CredDeleteW((**credential).TargetName, CRED_TYPE_GENERIC, 0) == 0 && GetLastError() != ERROR_NOT_FOUND { return Err(failure()); }
            }
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod system {
    pub fn access(_: &str, _: &str, _: Option<&str>) -> Result<Option<String>, String> { Err("Persistent plugin credentials currently require Windows".into()) }
    pub fn forget(_: &str) -> Result<(), String> { Ok(()) }
    pub fn list(_: &str) -> Result<Vec<(String, String)>, String> { Ok(Vec::new()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_are_scoped_to_plugin_origin_port_and_key() {
        let base = target("one", "https://example.com", "password");
        for other in [target("two", "https://example.com", "password"), target("one", "https://example.com:8443", "password"), target("one", "https://other.example.com", "password"), target("one", "https://example.com", "token")] { assert_ne!(base, other); }
        assert!(base.starts_with(&prefix("one")));
        assert!(!base.starts_with(&prefix("on")));
        assert!(access("one", "https://example.com", "", "get", None).is_err());
        assert!(access("one", "https://example.com", "key", "set", Some(&"x".repeat(2561))).is_err());
        assert!(valid_target(&base));
        let longer = format!("{base}0");
        let nested = base.replace("one", "o/e");
        for bad in ["Nexterm/Plugins/one/", "Nexterm/Plugins//abc", "Other/one/0000", longer.as_str(), nested.as_str()] { assert!(!valid_target(bad), "{bad}"); }
        assert!(put("Other/x", "v").is_err() && remove("Nexterm/Plugins/one/zz").is_err());
    }
    #[cfg(windows)]
    #[test]
    fn system_credentials_survive_reads_and_can_be_forgotten() {
        let id = format!("test-{}", uuid::Uuid::new_v4());
        let origin = "https://example.com:8443";
        assert_eq!(access(&id, origin, "login", "get", None).unwrap(), None);
        access(&id, origin, "login", "set", Some("test-password")).unwrap();
        let result = access(&id, origin, "login", "get", None);
        let isolated = access(&id, "https://example.com", "login", "get", None);
        forget(&id).unwrap();
        assert_eq!(result.unwrap().as_deref(), Some("test-password"));
        assert_eq!(isolated.unwrap(), None);
        assert_eq!(access(&id, origin, "login", "get", None).unwrap(), None);
    }
}
