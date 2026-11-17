//! Font families installed on this computer, for the terminal font picker.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SystemFont {
    pub name: String,
    /// Fixed pitch (every glyph the same width): what a terminal wants.
    pub monospace: bool,
}

/// Sorted by name, one entry per family; vertical ("@...") variants left out.
pub fn list() -> Vec<SystemFont> {
    let mut fonts = enumerate();
    normalize(&mut fonts);
    fonts
}

fn normalize(fonts: &mut Vec<SystemFont>) {
    fonts.retain(|f| !f.name.is_empty() && !f.name.starts_with('@'));
    fonts.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(b.monospace.cmp(&a.monospace))
    });
    // A family is listed once per charset; keep it monospace if any entry says so.
    fonts.dedup_by(|later, kept| {
        if later.name.eq_ignore_ascii_case(&kept.name) {
            kept.monospace |= later.monospace;
            true
        } else {
            false
        }
    });
}

#[cfg(windows)]
fn enumerate() -> Vec<SystemFont> {
    use windows_sys::Win32::Foundation::LPARAM;
    use windows_sys::Win32::Graphics::Gdi::{
        EnumFontFamiliesExW, GetDC, ReleaseDC, LOGFONTW, TEXTMETRICW,
    };

    unsafe extern "system" fn callback(
        lf: *const LOGFONTW,
        _tm: *const TEXTMETRICW,
        _font_type: u32,
        lparam: LPARAM,
    ) -> i32 {
        let out = &mut *(lparam as *mut Vec<SystemFont>);
        let lf = &*lf;
        let len = lf.lfFaceName.iter().position(|&c| c == 0).unwrap_or(lf.lfFaceName.len());
        out.push(SystemFont {
            name: String::from_utf16_lossy(&lf.lfFaceName[..len]),
            // Low two bits of lfPitchAndFamily: 1 = FIXED_PITCH.
            monospace: (lf.lfPitchAndFamily as u32) & 0x03 == 1,
        });
        1
    }

    let mut out: Vec<SystemFont> = Vec::new();
    unsafe {
        let hdc = GetDC(0);
        if hdc == 0 {
            return out;
        }
        let mut lf: LOGFONTW = std::mem::zeroed();
        lf.lfCharSet = 1 as _; // DEFAULT_CHARSET: every charset, every family
        EnumFontFamiliesExW(hdc, &lf, Some(callback), &mut out as *mut _ as LPARAM, 0);
        ReleaseDC(0, hdc);
    }
    out
}

#[cfg(not(windows))]
fn enumerate() -> Vec<SystemFont> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(name: &str, monospace: bool) -> SystemFont {
        SystemFont { name: name.into(), monospace }
    }

    #[test]
    fn normalize_sorts_dedups_and_drops_vertical() {
        let mut fonts = vec![
            f("Consolas", true),
            f("@SimSun", false),
            f("arial", false),
            f("SimSun", false),
            f("Consolas", false),
            f("SimSun", true),
            f("", false),
        ];
        normalize(&mut fonts);
        assert_eq!(fonts, vec![f("arial", false), f("Consolas", true), f("SimSun", true)]);
    }

    /// Consolas ships with every Windows 10/11.
    #[cfg(windows)]
    #[test]
    fn lists_installed_fonts() {
        let fonts = list();
        let consolas = fonts.iter().find(|f| f.name == "Consolas").expect("Consolas installed");
        assert!(consolas.monospace);
        assert!(fonts.iter().any(|f| !f.monospace));
        assert!(!fonts.iter().any(|f| f.name.starts_with('@')));
    }
}
