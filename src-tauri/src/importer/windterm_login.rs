use std::{fs, path::Path};

use aes::cipher::{block_padding::Pkcs7, BlockModeDecrypt, KeyIvInit};
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use zeroize::Zeroizing;

pub(super) struct ProfileKey(Zeroizing<[u8; 48]>);

#[derive(Deserialize)]
pub(super) struct Login {
    #[serde(rename = "session.user", default)]
    pub username: String,
    #[serde(rename = "Password")]
    password: Option<String>,
    #[serde(rename = "PasswordEnabled")]
    enabled: Option<bool>,
    /// The private key and its passphrase, as WindTerm keeps them in the login.
    #[serde(rename = "Public Key", default)]
    public_key: Option<PublicKey>,
}

/// `{"windows.path", "windows.pass", "path", "pass"}`; the Windows entries win.
#[derive(Deserialize, Default)]
struct PublicKey {
    #[serde(rename = "windows.path")]
    windows_path: Option<String>,
    path: Option<String>,
    #[serde(rename = "windows.pass")]
    windows_pass: Option<String>,
    pass: Option<String>,
}

fn first(a: Option<String>, b: Option<String>) -> Option<String> {
    a.filter(|s| !s.is_empty()).or(b.filter(|s| !s.is_empty()))
}

impl Login {
    pub fn take_password(&mut self) -> Option<String> {
        self.password.take().filter(|value| self.enabled != Some(false) && !value.is_empty())
    }

    /// The private key path and passphrase saved with the login.
    pub fn take_key(&mut self) -> (Option<String>, Option<String>) {
        let key = self.public_key.take().unwrap_or_default();
        (first(key.windows_path, key.path), first(key.windows_pass, key.pass))
    }
}

impl ProfileKey {
    pub fn load(sessions_path: &Path, master: &str) -> Result<Self> {
        #[derive(Deserialize)]
        struct Profile {
            #[serde(rename = "application.fingerprint")]
            fingerprint: String,
            #[serde(default, rename = "application.masterPassword")]
            protected: bool,
        }

        let dir = sessions_path.parent().context("windtermProfile")?;
        let profile_dir = if dir.file_name().is_some_and(|name| name.eq_ignore_ascii_case("terminal")) {
            dir.parent().context("windtermProfile")?
        } else {
            dir
        };
        let raw = fs::read_to_string(profile_dir.join("user.config")).ok().context("windtermProfile")?;
        let profile: Profile = serde_json::from_str(&super::strip_json_comments(raw.trim_start_matches('\u{feff}')))
            .ok().context("windtermProfile")?;
        anyhow::ensure!(!profile.fingerprint.is_empty(), "windtermProfile");
        anyhow::ensure!(!profile.protected || !master.is_empty(), "windtermMasterRequired");
        // Without a master password WindTerm derives the key from an empty one; ignore
        // whatever was typed into the field.
        let master = if profile.protected { master } else { "" };
        let mut material = Zeroizing::new([0; 48]);
        pbkdf2::pbkdf2::<pbkdf2::hmac::SimpleHmac<sha3::Sha3_512>>(
            master.as_bytes(), profile.fingerprint.as_bytes(), 100_000, &mut material[..],
        ).expect("HMAC accepts arbitrary password lengths");
        Ok(Self(material))
    }

    pub fn decrypt(&self, blob: &str) -> Result<Login> {
        let mut data = Zeroizing::new(STANDARD.decode(blob).ok().context("windtermDecryptFailed")?);
        let (key, iv) = self.0.split_at(32);
        let plaintext = cbc::Decryptor::<aes::Aes256>::new_from_slices(key, iv)
            .expect("fixed WindTerm key and IV lengths")
            .decrypt_padded::<Pkcs7>(&mut data).ok().context("windtermDecryptFailed")?;
        serde_json::from_slice(plaintext).ok().context("windtermDecryptFailed")
    }
}
