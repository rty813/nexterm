//! Terminal background images: a picked file is copied into `<data>/backgrounds/` so the
//! setting keeps working when the original moves, and each window reads it back as bytes.

use std::fs;
use std::path::{Path, PathBuf};

/// Largest image accepted (bytes).
pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
/// Copies kept in the folder (the newest ones); older imports are removed.
const KEEP_FILES: usize = 5;

const EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

pub fn dir(base: &Path) -> PathBuf {
    base.join("backgrounds")
}

/// Lower-case image extension of `path`, if it is one we accept.
pub fn image_extension(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    EXTENSIONS.contains(&ext.as_str()).then_some(ext)
}

/// A stored file name: `bg-<id>.<ext>`, nothing that could leave the folder.
pub fn valid_name(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else { return false };
    stem.starts_with("bg-")
        && stem.len() > 3
        && stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && EXTENSIONS.contains(&ext)
}

pub fn mime(name: &str) -> &'static str {
    match name.rsplit_once('.').map(|(_, e)| e) {
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        _ => "image/jpeg",
    }
}

/// Copy `source` into the backgrounds folder; returns the stored name.
pub fn import(base: &Path, source: &Path) -> Result<String, String> {
    let ext = image_extension(source).ok_or_else(|| "unsupported image type".to_string())?;
    let meta = fs::metadata(source).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err("image too large".into());
    }
    let folder = dir(base);
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let name = format!("bg-{}.{}", uuid::Uuid::new_v4().simple(), ext);
    fs::copy(source, folder.join(&name)).map_err(|e| e.to_string())?;
    prune(&folder, &name);
    Ok(name)
}

pub fn read(base: &Path, name: &str) -> Result<Vec<u8>, String> {
    if !valid_name(name) {
        return Err("invalid background name".into());
    }
    fs::read(dir(base).join(name)).map_err(|e| e.to_string())
}

/// Keep the newest KEEP_FILES images (and always `keep`).
fn prune(folder: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(folder) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| e.file_name().to_str().is_some_and(|n| valid_name(n) && n != keep))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in files.into_iter().skip(KEEP_FILES - 1) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(valid_name("bg-0123abcd.png"));
        assert!(valid_name("bg-x.jpeg"));
        assert!(!valid_name("bg-.png"));
        assert!(!valid_name("../bg-a.png"));
        assert!(!valid_name(r"bg-a\b.png"));
        assert!(!valid_name("bg-a.exe"));
        assert!(!valid_name("other.png"));
        assert!(!valid_name("bg-a"));
    }

    #[test]
    fn extensions() {
        assert_eq!(image_extension(Path::new("C:/x/Photo.JPG")).as_deref(), Some("jpg"));
        assert_eq!(image_extension(Path::new("a.svg")), None);
        assert_eq!(image_extension(Path::new("noext")), None);
    }

    #[test]
    fn import_read_and_prune() {
        let base = std::env::temp_dir().join(format!("nexterm-bg-test-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&base).unwrap();
        let src = base.join("pic.png");
        fs::write(&src, b"\x89PNG data").unwrap();
        let mut names = Vec::new();
        for _ in 0..7 {
            names.push(import(&base, &src).unwrap());
        }
        assert_eq!(read(&base, names.last().unwrap()).unwrap(), b"\x89PNG data");
        assert!(fs::read_dir(dir(&base)).unwrap().count() <= KEEP_FILES);
        assert!(import(&base, &base.join("pic.txt")).is_err());
        assert!(read(&base, "../pic.png").is_err());
        let _ = fs::remove_dir_all(&base);
    }
}
