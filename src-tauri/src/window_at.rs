//! Which terminal window is under a screen point (docking a dragged window, dropping a
//! tab outside its window). Rectangles alone are not enough: the window must also be
//! the topmost one there, so a Nexterm window covered by another program (or on another
//! virtual desktop) does not take the drop.

use tauri::{AppHandle, Manager};

/// A screen rectangle in physical pixels, right / bottom exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
}

/// A visible top-level window, as seen on screen.
#[derive(Debug, Clone, Copy)]
pub struct Layer {
    pub id: isize,
    pub bounds: Rect,
}

/// One of our terminal windows; only its client area takes drops.
#[derive(Debug, Clone)]
pub struct Target {
    pub id: isize,
    pub label: String,
    pub client: Rect,
}

/// `layers` top to bottom: the first one containing the point decides. It is a drop
/// target only if it is one of ours and the point is in its client area.
pub fn pick(layers: impl IntoIterator<Item = Layer>, targets: &[Target], x: i32, y: i32) -> Option<String> {
    let top = layers.into_iter().find(|l| l.bounds.contains(x, y))?;
    targets
        .iter()
        .find(|t| t.id == top.id && t.client.contains(x, y))
        .map(|t| t.label.clone())
}

fn is_terminal_window(label: &str) -> bool {
    label == "main" || label.starts_with("term-")
}

/// The terminal window (not one of `exclude`) that is topmost at (`x`, `y`).
pub fn terminal_window_at(app: &AppHandle, x: i32, y: i32, exclude: &[String]) -> Option<String> {
    let mut targets = Vec::new();
    let mut skip = Vec::new();
    for (label, w) in app.webview_windows() {
        if !is_terminal_window(&label) {
            continue;
        }
        let Some(id) = window_id(&w) else { continue };
        if exclude.contains(&label) {
            skip.push(id);
            continue;
        }
        if !w.is_visible().unwrap_or(false) || w.is_minimized().unwrap_or(false) {
            continue;
        }
        if let Some(client) = client_rect(&w) {
            targets.push(Target { id, label, client });
        }
    }
    pick(layers(&skip, &targets), &targets, x, y)
}

#[cfg(windows)]
fn window_id(w: &tauri::WebviewWindow) -> Option<isize> {
    w.hwnd().ok().map(|h| h.0 as isize)
}

#[cfg(windows)]
fn client_rect(w: &tauri::WebviewWindow) -> Option<Rect> {
    use windows_sys::Win32::Foundation::{POINT, RECT};
    use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect;
    let hwnd = window_id(w)?;
    unsafe {
        let mut r: RECT = std::mem::zeroed();
        if GetClientRect(hwnd, &mut r) == 0 {
            return None;
        }
        let mut origin = POINT { x: 0, y: 0 };
        if ClientToScreen(hwnd, &mut origin) == 0 {
            return None;
        }
        Some(Rect {
            left: origin.x,
            top: origin.y,
            right: origin.x + (r.right - r.left),
            bottom: origin.y + (r.bottom - r.top),
        })
    }
}

/// Every visible top-level window from the top of the z-order down, lazily (the caller
/// stops at the first hit). Click-through, cloaked (other virtual desktop, suspended
/// app) and minimized windows are skipped, as are `skip` (the window being dragged).
#[cfg(windows)]
fn layers<'a>(skip: &'a [isize], _targets: &[Target]) -> impl Iterator<Item = Layer> + 'a {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetTopWindow, GetWindow, GetWindowLongW, GetWindowRect, IsIconic, IsWindowVisible, GWL_EXSTYLE, GW_HWNDNEXT,
        WS_EX_TRANSPARENT,
    };
    let mut next = unsafe { GetTopWindow(0) };
    let mut steps = 0u32;
    let hwnds = std::iter::from_fn(move || {
        // A window list that changes while we walk it could, in theory, loop.
        if next == 0 || steps > 20_000 {
            return None;
        }
        steps += 1;
        let h = next;
        next = unsafe { GetWindow(h, GW_HWNDNEXT) };
        Some(h)
    });
    hwnds.filter_map(move |h| unsafe {
        if skip.contains(&h) || IsWindowVisible(h) == 0 || IsIconic(h) != 0 {
            return None;
        }
        if GetWindowLongW(h, GWL_EXSTYLE) as u32 & WS_EX_TRANSPARENT != 0 {
            return None;
        }
        let mut cloaked: u32 = 0;
        let size = std::mem::size_of::<u32>() as u32;
        if DwmGetWindowAttribute(h, DWMWA_CLOAKED as u32, &mut cloaked as *mut u32 as *mut _, size) == 0 && cloaked != 0 {
            return None;
        }
        // The visible frame, without the invisible resize borders of Windows 10/11.
        let mut r: RECT = std::mem::zeroed();
        let size = std::mem::size_of::<RECT>() as u32;
        if DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS as u32, &mut r as *mut RECT as *mut _, size) != 0
            && GetWindowRect(h, &mut r) == 0
        {
            return None;
        }
        if r.right <= r.left || r.bottom <= r.top {
            return None;
        }
        Some(Layer { id: h, bounds: Rect { left: r.left, top: r.top, right: r.right, bottom: r.bottom } })
    })
}

// Elsewhere (development builds only) there is no z-order: our windows by rectangle.
#[cfg(not(windows))]
fn window_id(w: &tauri::WebviewWindow) -> Option<isize> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    w.label().hash(&mut h);
    Some(h.finish() as isize)
}

#[cfg(not(windows))]
fn client_rect(w: &tauri::WebviewWindow) -> Option<Rect> {
    let (pos, size) = (w.inner_position().ok()?, w.inner_size().ok()?);
    Some(Rect { left: pos.x, top: pos.y, right: pos.x + size.width as i32, bottom: pos.y + size.height as i32 })
}

#[cfg(not(windows))]
fn layers<'a>(_skip: &'a [isize], targets: &[Target]) -> impl Iterator<Item = Layer> + 'a {
    targets.iter().map(|t| Layer { id: t.id, bounds: t.client }).collect::<Vec<_>>().into_iter()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(left: i32, top: i32, w: i32, h: i32) -> Rect {
        Rect { left, top, right: left + w, bottom: top + h }
    }

    fn main_target() -> Target {
        Target { id: 1, label: "main".into(), client: rect(100, 100, 800, 600) }
    }

    #[test]
    fn topmost_window_of_ours_takes_the_point() {
        let layers = [Layer { id: 1, bounds: rect(92, 70, 816, 638) }];
        assert_eq!(pick(layers, &[main_target()], 400, 300).as_deref(), Some("main"));
    }

    #[test]
    fn window_covered_by_another_program_does_not() {
        // A browser in front of the main window, on the same monitor.
        let layers = [Layer { id: 9, bounds: rect(0, 0, 1920, 1040) }, Layer { id: 1, bounds: rect(92, 70, 816, 638) }];
        assert_eq!(pick(layers, &[main_target()], 400, 300), None);
    }

    #[test]
    fn partly_covered_window_takes_its_visible_part() {
        let layers = [Layer { id: 9, bounds: rect(0, 0, 300, 1040) }, Layer { id: 1, bounds: rect(92, 70, 816, 638) }];
        assert_eq!(pick(layers, &[main_target()], 200, 300), None);
        assert_eq!(pick(layers, &[main_target()], 400, 300).as_deref(), Some("main"));
    }

    #[test]
    fn frame_of_our_window_is_not_a_drop_target() {
        let layers = [Layer { id: 1, bounds: rect(92, 70, 816, 638) }];
        assert_eq!(pick(layers, &[main_target()], 400, 80), None);
    }

    #[test]
    fn nothing_under_the_point() {
        let layers = [Layer { id: 1, bounds: rect(92, 70, 816, 638) }];
        assert_eq!(pick(layers, &[main_target()], 2500, 300), None);
    }

    #[test]
    fn negative_coordinates_of_a_monitor_left_of_the_primary() {
        let t = Target { id: 2, label: "term-1".into(), client: rect(-1800, 100, 800, 600) };
        let layers = [Layer { id: 2, bounds: rect(-1808, 70, 816, 638) }];
        assert_eq!(pick(layers, &[t], -1500, 300).as_deref(), Some("term-1"));
    }
}
