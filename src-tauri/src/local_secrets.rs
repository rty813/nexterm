//! Local data files protected with Windows user-scoped DPAPI: the whole `sessions.json`,
//! and the `sync`, `remote` and `httpProxy` parts of `settings.json`. A protected part is
//! stored as `{"format": "nexterm-dpapi-v1", "ciphertext": "<base64>"}`.
//!
//! Errors carry a code the frontend translates: [`UNREADABLE`] (this Windows account cannot
//! open the data: another computer or account, a reset profile) or [`INVALID`] (the file is
//! damaged). Both can be recovered from by setting the file aside ([`set_aside`]).

use std::{fs, io::{ErrorKind, Write}, path::{Path, PathBuf}};

use anyhow::{anyhow, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use zeroize::Zeroizing;

const FORMAT: &str = "nexterm-dpapi-v1";
/// This Windows account cannot decrypt the data.
pub const UNREADABLE: &str = "localDataUnreadable";
/// The file is not valid JSON or does not have the expected shape.
pub const INVALID: &str = "localDataInvalid";

const SESSIONS_PURPOSE: &[u8] = b"Nexterm/sessions/v1";
/// Settings keys kept encrypted, with the DPAPI entropy of each.
const SETTINGS_SLOTS: &[(&str, &[u8])] = &[
    ("sync", b"Nexterm/settings.sync/v1"),
    ("remote", b"Nexterm/settings.remote/v1"),
    ("httpProxy", b"Nexterm/settings.httpProxy/v1"),
];

#[cfg(windows)]
fn dpapi(input: &[u8], purpose: &[u8], protect: bool) -> Result<Zeroizing<Vec<u8>>> {
    use std::{ptr, slice};
    use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    }};
    use zeroize::Zeroize;

    fn blob(bytes: &[u8]) -> Result<CRYPT_INTEGER_BLOB> {
        Ok(CRYPT_INTEGER_BLOB { cbData: bytes.len().try_into()?, pbData: bytes.as_ptr().cast_mut() })
    }
    let input = blob(input)?;
    let entropy = blob(purpose)?;
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() };
    unsafe {
        let ok = if protect {
            CryptProtectData(&input, ptr::null(), &entropy, ptr::null(), ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        } else {
            CryptUnprotectData(&input, ptr::null_mut(), &entropy, ptr::null(), ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        if ok == 0 { return Err(std::io::Error::last_os_error()).context("Windows data protection failed"); }
        ensure!(!out.pbData.is_null(), "Windows returned no protected data");
        let bytes = slice::from_raw_parts_mut(out.pbData, out.cbData as usize);
        let result = Zeroizing::new(bytes.to_vec());
        bytes.zeroize();
        LocalFree(out.pbData.cast());
        Ok(result)
    }
}

#[cfg(not(windows))]
fn dpapi(_: &[u8], _: &[u8], _: bool) -> Result<Zeroizing<Vec<u8>>> {
    anyhow::bail!("Windows user data protection is unavailable")
}

/// Whether an error is one [`set_aside`] recovers from (not an I/O error such as a locked file).
pub(crate) fn recoverable(err: &anyhow::Error) -> bool {
    let code = err.to_string();
    code == UNREADABLE || code == INVALID
}

fn sealed(value: &Value) -> bool {
    value.as_object().is_some_and(|o| o.contains_key("format") && o.contains_key("ciphertext"))
}

fn unseal(slot: &Value, purpose: &[u8]) -> Result<Value> {
    ensure!(slot["format"] == FORMAT, INVALID);
    let cipher = STANDARD.decode(slot["ciphertext"].as_str().context(INVALID)?).ok().context(INVALID)?;
    let plain = dpapi(&cipher, purpose, false).context(UNREADABLE)?;
    serde_json::from_slice(&plain).ok().context(INVALID)
}

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub(crate) enum Kind { Sessions, Settings }

impl Kind {
    pub fn named(name: &str) -> Option<Self> {
        match name { "sessions" => Some(Self::Sessions), "settings" => Some(Self::Settings), _ => None }
    }

    /// The protected parts of a file: (name, DPAPI entropy, value). Null settings are left out.
    fn slots(self, value: &mut Value) -> Result<Vec<(&'static str, &'static [u8], &mut Value)>> {
        match self {
            Self::Sessions => Ok(vec![("", SESSIONS_PURPOSE, value)]),
            Self::Settings => Ok(value.as_object_mut().context(INVALID)?.iter_mut().filter_map(|(key, slot)| {
                let (name, purpose) = SETTINGS_SLOTS.iter().find(|(name, _)| name == key)?;
                (!slot.is_null()).then_some((*name, *purpose, slot))
            }).collect()),
        }
    }

    fn validate(self, slot: &Value) -> Result<()> {
        match self {
            Self::Sessions => { serde_json::from_value::<Vec<crate::models::SessionConfig>>(slot.clone()).map_err(|_| anyhow!(INVALID))?; }
            Self::Settings => ensure!(slot.is_object(), INVALID),
        }
        Ok(())
    }

    /// Encrypt the parts of `value` that are still plain text.
    pub fn protect(self, mut value: Value) -> Result<Value> {
        for (_, purpose, slot) in self.slots(&mut value)? {
            if sealed(slot) { continue; }
            let plain = Zeroizing::new(serde_json::to_vec(slot)?);
            let encrypted = dpapi(&plain, purpose, true)?;
            *slot = json!({"format": FORMAT, "ciphertext": STANDARD.encode(&*encrypted)});
        }
        Ok(value)
    }

    /// The file decrypted; none when it does not exist. With `migrate`, a file that still
    /// has plain-text parts is rewritten encrypted.
    pub fn read(self, path: &Path, migrate: bool) -> Result<Option<Value>> {
        let Some(value) = read_value(path)? else { return Ok(None) };
        let (value, plain) = self.open(value, false)?;
        if plain && migrate {
            write_atomic(path, &self.protect(value.clone())?)?;
        }
        Ok(Some(value))
    }

    /// Settings with every part this account can open; parts that cannot be opened (or are
    /// damaged) are left out. None when the file is missing or is not a JSON object.
    pub fn read_salvaged(self, path: &Path) -> Result<Option<Value>> {
        let value = match read_value(path) {
            Ok(value) => value,
            Err(e) if recoverable(&e) => return Ok(None),
            Err(e) => return Err(e),
        };
        match value.map(|v| self.open(v, true)) {
            Some(Ok((value, _))) => Ok(Some(value)),
            Some(Err(e)) if recoverable(&e) => Ok(None),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    /// Decrypt the protected parts. Returns the value and whether any part was plain text.
    /// `drop_bad` (settings only) removes parts that fail instead of failing.
    fn open(self, mut value: Value, drop_bad: bool) -> Result<(Value, bool)> {
        let mut plain = false;
        let mut bad = Vec::new();
        for (name, purpose, slot) in self.slots(&mut value)? {
            let opened = if sealed(slot) { unseal(slot, purpose) } else { plain = true; Ok(slot.clone()) };
            match opened.and_then(|v| self.validate(&v).map(|_| v)) {
                Ok(v) => *slot = v,
                Err(_) if drop_bad && self == Self::Settings => bad.push(name),
                Err(e) => return Err(e),
            }
        }
        if let Some(map) = value.as_object_mut() {
            for name in bad { map.remove(name); }
        }
        Ok((value, plain))
    }
}

fn read_value(path: &Path) -> Result<Option<Value>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => Zeroizing::new(bytes),
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let text = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    serde_json::from_slice(text).ok().context(INVALID).map(Some)
}

/// Whether the file on disk holds no plain-text part (so a copy of it leaks nothing).
pub(crate) fn sealed_on_disk(kind: Kind, path: &Path) -> bool {
    let Ok(Some(mut value)) = read_value(path) else { return false };
    kind.slots(&mut value).is_ok_and(|slots| slots.iter().all(|(_, _, slot)| sealed(slot)))
}

/// Keep a file that cannot be used as `<name>.unreadable-<time>` next to it: moved, or
/// copied when `copy` (the caller rewrites the original). Returns the kept file.
pub(crate) fn set_aside(path: &Path, copy: bool) -> Result<PathBuf> {
    let name = path.file_name().context("Missing file name")?.to_string_lossy();
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%.3f");
    let kept = path.with_file_name(format!("{name}.unreadable-{stamp}"));
    if copy { fs::copy(path, &kept)?; } else { fs::rename(path, &kept)?; }
    Ok(kept)
}

pub(crate) fn write_atomic(path: &Path, value: &Value) -> Result<()> {
    let mut tmp = tempfile::NamedTempFile::new_in(path.parent().context("Missing configuration directory")?)?;
    serde_json::to_writer_pretty(&mut tmp, value)?;
    tmp.flush()?;
    tmp.as_file().sync_all()?;
    tmp.persist(path)?;
    Ok(())
}

/// Encrypt plain-text sessions and settings left in `backups/` by earlier versions. Best
/// effort: a backup that cannot be read or rewritten is skipped (and logged), never fatal.
pub(crate) fn migrate_backups(base: &Path) {
    let root = base.join("backups");
    match fs::symlink_metadata(&root) {
        Ok(meta) if meta.file_type().is_dir() => (),
        _ => return,
    }
    let Ok(entries) = fs::read_dir(&root) else { return };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) { continue; }
        for (name, kind) in [("sessions.json", Kind::Sessions), ("settings.json", Kind::Settings)] {
            let path = entry.path().join(name);
            if !fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_file()) { continue; }
            if let Err(e) = kind.read(&path, true) {
                eprintln!("backup not migrated: {}: {e:#}", path.display());
            }
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn settings_keep_what_can_be_opened() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let plain = json!({"fontSize": 14, "sync": {"password": "p"}, "remote": {"hostToken": "t"}, "httpProxy": {"url": "http://u:p@h"}});
        write_atomic(&path, &plain).unwrap();
        assert_eq!(Kind::Settings.read(&path, true).unwrap().unwrap(), plain);
        let disk = fs::read_to_string(&path).unwrap();
        assert!(!disk.contains("hostToken") && !disk.contains("u:p@h") && !disk.contains("password"));
        assert!(disk.contains("fontSize") && sealed_on_disk(Kind::Settings, &path));

        // A part another account sealed (here: damaged) is dropped; the rest stays.
        let mut value: Value = serde_json::from_str(&disk).unwrap();
        value["remote"]["ciphertext"] = json!("YWJj");
        write_atomic(&path, &value).unwrap();
        assert_eq!(Kind::Settings.read(&path, false).unwrap_err().to_string(), UNREADABLE);
        let salvaged = Kind::Settings.read_salvaged(&path).unwrap().unwrap();
        assert!(salvaged.get("remote").is_none());
        assert_eq!(salvaged["sync"], plain["sync"]);

        fs::write(&path, "{not json").unwrap();
        assert_eq!(Kind::Settings.read(&path, false).unwrap_err().to_string(), INVALID);
        assert!(Kind::Settings.read_salvaged(&path).unwrap().is_none());
        let kept = set_aside(&path, false).unwrap();
        assert!(!path.exists() && kept.exists());
    }

    #[test]
    fn broken_backups_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let bad = dir.path().join("backups").join("1");
        let good = dir.path().join("backups").join("2");
        fs::create_dir_all(&bad).unwrap();
        fs::create_dir_all(&good).unwrap();
        fs::write(bad.join("sessions.json"), "[{\"old\":").unwrap();
        fs::write(bad.join("settings.json"), "[]").unwrap();
        fs::write(good.join("settings.json"), r#"{"sync":{"password":"secret"}}"#).unwrap();
        migrate_backups(dir.path());
        assert_eq!(fs::read_to_string(bad.join("sessions.json")).unwrap(), "[{\"old\":");
        assert!(!fs::read_to_string(good.join("settings.json")).unwrap().contains("secret"));
    }
}
