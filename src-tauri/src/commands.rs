//! Command catalog for auto completion: the `<name>[,<alias>].command` files
//! (description, synopses, options) bundled with the app in resources/commands.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandOption {
    /// What gets inserted: `-a`, `--all`, `--block-size=`, `-Path` ...
    pub flags: Vec<String>,
    /// The option as documented, e.g. `--block-size=SIZE`.
    pub label: String,
    pub description: String,
}

struct Index {
    entries: Vec<CatalogEntry>,
    files: HashMap<String, PathBuf>,
}

fn commands_root() -> Option<PathBuf> {
    Some(crate::app_paths::resource("commands")).filter(|p| p.is_dir())
}

/// Folders searched for a highlight / shell scheme.
fn scheme_dirs(root: &Path, scheme: &str) -> Vec<PathBuf> {
    let names: &[&str] = match scheme {
        "powershell" => &["powershell"],
        "cmd" => &["cmd"],
        // linux, macos, routeros, wsl ...: POSIX tools plus git.
        _ => &["linux", "git"],
    };
    names.iter().map(|n| root.join(n)).filter(|p| p.is_dir()).collect()
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut items: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    // Newest versions first (v7.3 before v5.1), so their files win duplicates.
    items.sort_by(|a, b| b.cmp(a));
    for p in items {
        if p.is_dir() {
            if depth < 4 {
                walk(&p, out, depth + 1);
            }
        } else if p.extension().is_some_and(|e| e == "command") {
            out.push(p);
        }
    }
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

fn unquote(s: &str) -> String {
    let t = s.trim();
    let t = if t == "~" { "" } else { t };
    let t = t
        .strip_prefix('\'')
        .and_then(|x| x.strip_suffix('\''))
        .or_else(|| t.strip_prefix('"').and_then(|x| x.strip_suffix('"')))
        .unwrap_or(t);
    t.replace("''", "'")
}

/// The top-level `description:` of a command file (inline or as an indented block).
pub fn parse_description(text: &str) -> String {
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        if indent_of(line) == 0 {
            if let Some(rest) = line.strip_prefix("description:") {
                if !rest.trim().is_empty() {
                    return unquote(rest);
                }
                let mut parts = Vec::new();
                for l in lines.by_ref() {
                    if indent_of(l) == 0 && !l.trim().is_empty() {
                        break;
                    }
                    parts.push(l.trim());
                }
                return unquote(&parts.join(" "));
            }
        }
    }
    String::new()
}

/// `-a, --all` / `--block-size=SIZE` / `-Directory,-ad Switch` -> inserted flags.
fn flags_of(key: &str) -> Vec<String> {
    let mut out = Vec::new();
    for part in key.split(',') {
        let token = part.split_whitespace().next().unwrap_or("");
        let token = token.split(['[', '<']).next().unwrap_or("");
        let token = match token.find('=') {
            Some(i) => &token[..=i],
            None => token,
        };
        if token.len() > 1 && (token.starts_with('-') || token.starts_with('/')) && !out.iter().any(|f| f == token) {
            out.push(token.to_string());
        }
    }
    out
}

/// The `options:` section of a command file.
pub fn parse_options(text: &str) -> Vec<CommandOption> {
    let mut out: Vec<CommandOption> = Vec::new();
    let mut in_options = false;
    for line in text.lines() {
        let indent = indent_of(line);
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if indent == 0 {
            in_options = t == "options:";
            continue;
        }
        if !in_options {
            continue;
        }
        if indent == 2 && (t.starts_with('-') || t.starts_with('/')) && !t.starts_with("- ") {
            let (key, value) = match t.find(": ") {
                Some(i) => (&t[..i], &t[i + 2..]),
                None => (t.trim_end_matches(':'), ""),
            };
            let flags = flags_of(key);
            if !flags.is_empty() {
                out.push(CommandOption { flags, label: key.to_string(), description: unquote(value) });
            }
        } else if indent == 4 {
            if let (Some(last), Some(rest)) = (out.last_mut(), t.strip_prefix("description:")) {
                if last.description.is_empty() {
                    last.description = unquote(rest);
                }
            }
        }
    }
    out
}

fn indexes() -> &'static Mutex<HashMap<String, std::sync::Arc<Index>>> {
    static INDEXES: OnceLock<Mutex<HashMap<String, std::sync::Arc<Index>>>> = OnceLock::new();
    INDEXES.get_or_init(Default::default)
}

fn index(scheme: &str) -> std::sync::Arc<Index> {
    let key = scheme.to_string();
    if let Some(i) = indexes().lock().ok().and_then(|m| m.get(&key).cloned()) {
        return i;
    }
    let mut files: HashMap<String, PathBuf> = HashMap::new();
    let mut entries = Vec::new();
    if let Some(root) = commands_root() {
        let mut paths = Vec::new();
        for dir in scheme_dirs(&root, scheme) {
            walk(&dir, &mut paths, 0);
        }
        for path in paths {
            let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if stem.starts_with("__") {
                continue;
            }
            let names: Vec<String> = stem.split(',').map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect();
            if names.iter().all(|n| files.contains_key(n)) {
                continue;
            }
            let description = std::fs::read_to_string(&path).map(|t| parse_description(&t)).unwrap_or_default();
            for name in names {
                if files.contains_key(&name) {
                    continue;
                }
                files.insert(name.clone(), path.clone());
                entries.push(CatalogEntry { name, description: description.clone() });
            }
        }
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    let idx = std::sync::Arc::new(Index { entries, files });
    if let Ok(mut m) = indexes().lock() {
        m.insert(key, std::sync::Arc::clone(&idx));
    }
    idx
}

pub fn catalog(scheme: &str) -> Vec<CatalogEntry> {
    index(scheme).entries.clone()
}

pub fn options(scheme: &str, name: &str) -> Vec<CommandOption> {
    let idx = index(scheme);
    idx.files
        .get(name)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|t| parse_options(&t))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LS: &str = "description:\n  list directory contents\nsynopses:\n  - ls [OPTION]... [FILE]...\noptions:\n  -a, --all: do not ignore entries starting with .\n  --block-size=SIZE:\n    description: scale sizes by SIZE before printing them.\n    values:\n      - K: powers of 1024\n  -c: 'with -lt: sort by ctime'\n  --color[=WHEN]:\n    description: colorize the output\n";

    #[test]
    fn test_parse_linux_command() {
        assert_eq!(parse_description(LS), "list directory contents");
        let opts = parse_options(LS);
        assert_eq!(opts.len(), 4);
        assert_eq!(opts[0].flags, vec!["-a", "--all"]);
        assert_eq!(opts[1].flags, vec!["--block-size="]);
        assert_eq!(opts[1].description, "scale sizes by SIZE before printing them.");
        assert_eq!(opts[2].description, "with -lt: sort by ctime");
        assert_eq!(opts[3].flags, vec!["--color"]);
    }

    #[test]
    fn test_parse_powershell_command() {
        let text = "description: Gets the items\noptions:\n  -Attributes System.IO.FileAttributes:\n    values:\n    - Archive\n  -Directory,-ad Switch: ~\n";
        assert_eq!(parse_description(text), "Gets the items");
        let opts = parse_options(text);
        assert_eq!(opts[0].flags, vec!["-Attributes"]);
        assert_eq!(opts[1].flags, vec!["-Directory", "-ad"]);
        assert_eq!(opts[1].description, "");
    }
}
