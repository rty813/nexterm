//! Window opacity (settings.windowOpacity) as a layered window (`WS_EX_LAYERED` + alpha).
//!
//! tao rewrites a window's whole extended style whenever one of its own flags changes
//! (always on top, maximized, minimized ...), which drops `WS_EX_LAYERED` and with it the
//! opacity. So the wanted alpha is kept per window and put back after those changes:
//! `ensure` is cheap and does nothing while the window is still as it should be.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

fn wanted() -> &'static Mutex<HashMap<String, u8>> {
    static MAP: OnceLock<Mutex<HashMap<String, u8>>> = OnceLock::new();
    MAP.get_or_init(Default::default)
}

/// Opacity 0.2 - 1 as a layered-window alpha.
pub fn alpha_of(opacity: f64) -> u8 {
    (opacity.clamp(0.2, 1.0) * 255.0).round() as u8
}

/// Whether the window must be set again: it should be translucent but is not layered,
/// or is layered with another alpha (`current` is None when it is not layered).
pub fn needs_apply(wanted: u8, current: Option<u8>) -> bool {
    wanted < 255 && current != Some(wanted)
}

/// Remember the opacity of window `label` (applied by the next `apply` / `ensure`).
pub fn remember(label: &str, opacity: f64) {
    if let Ok(mut m) = wanted().lock() {
        m.insert(label.to_string(), alpha_of(opacity));
    }
}

pub fn forget(label: &str) {
    if let Ok(mut m) = wanted().lock() {
        m.remove(label);
    }
}

fn wanted_alpha(label: &str) -> Option<u8> {
    wanted().lock().ok()?.get(label).copied()
}

/// Set the window to its remembered opacity (also back to opaque).
pub fn apply(window: &tauri::Window) {
    if let Some(alpha) = wanted_alpha(window.label()) {
        #[cfg(windows)]
        if let Ok(hwnd) = window.hwnd() {
            win::set(hwnd.0 as isize, alpha);
        }
        #[cfg(not(windows))]
        let _ = alpha;
    }
}

/// Put the opacity back if something cleared it.
pub fn ensure(window: &tauri::Window) {
    let Some(alpha) = wanted_alpha(window.label()) else { return };
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        let hwnd = hwnd.0 as isize;
        if needs_apply(alpha, win::current(hwnd)) {
            win::set(hwnd, alpha);
        }
    }
    #[cfg(not(windows))]
    let _ = alpha;
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetLayeredWindowAttributes, GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE,
        LWA_ALPHA, WS_EX_LAYERED,
    };

    /// The window's alpha, None when it is not layered (or has no alpha set).
    pub fn current(hwnd: isize) -> Option<u8> {
        unsafe {
            if GetWindowLongPtrW(hwnd as _, GWL_EXSTYLE) & WS_EX_LAYERED as isize == 0 {
                return None;
            }
            let (mut key, mut alpha, mut flags) = (0u32, 0u8, 0u32);
            let ok = GetLayeredWindowAttributes(hwnd as _, &mut key, &mut alpha, &mut flags) != 0;
            (ok && flags & LWA_ALPHA != 0).then_some(alpha)
        }
    }

    pub fn set(hwnd: isize, alpha: u8) {
        unsafe {
            let style = GetWindowLongPtrW(hwnd as _, GWL_EXSTYLE);
            if alpha >= 255 {
                SetWindowLongPtrW(hwnd as _, GWL_EXSTYLE, style & !(WS_EX_LAYERED as isize));
            } else {
                SetWindowLongPtrW(hwnd as _, GWL_EXSTYLE, style | WS_EX_LAYERED as isize);
                SetLayeredWindowAttributes(hwnd as _, 0, alpha, LWA_ALPHA);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alpha_and_reapply() {
        assert_eq!(alpha_of(1.0), 255);
        assert_eq!(alpha_of(0.8), 204);
        assert_eq!(alpha_of(0.0), 51);
        // Opaque: nothing to restore.
        assert!(!needs_apply(255, None));
        // Translucent but the layered style was dropped, or another alpha.
        assert!(needs_apply(204, None));
        assert!(needs_apply(204, Some(255)));
        assert!(!needs_apply(204, Some(204)));
    }
}
