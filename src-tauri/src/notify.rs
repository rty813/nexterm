//! Windows toast notifications (agent finished / needs approval ...).
//!
//! The exe is not packaged, so it registers its own AppUserModelID under HKCU
//! (display name + icon), which is what unpackaged Win32 apps do to own their toasts.
//! A click on a toast is reported to the windows as `notification-clicked`.

use serde::Serialize;
use tauri::AppHandle;

pub const AUMID: &str = "Nexterm.Terminal";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationClick {
    /// What the notification was about (a pane id).
    pub tag: String,
}

fn xml_escape(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '&' => "&amp;".to_string(),
            '<' => "&lt;".to_string(),
            '>' => "&gt;".to_string(),
            '"' => "&quot;".to_string(),
            '\'' => "&apos;".to_string(),
            c if (c as u32) < 0x20 && c != '\n' && c != '\t' => " ".to_string(),
            c => c.to_string(),
        })
        .collect()
}

pub fn toast_xml(title: &str, body: &str, tag: &str) -> String {
    format!(
        r#"<toast launch="{}" activationType="foreground"><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual></toast>"#,
        xml_escape(tag),
        xml_escape(title),
        xml_escape(body)
    )
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::sync::Mutex;
    use tauri::Emitter;
    use windows::core::{Interface, HSTRING, IInspectable};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastActivatedEventArgs, ToastNotification, ToastNotificationManager};

    /// Toasts stay referenced so their Activated handlers live (last few only).
    fn alive() -> &'static Mutex<Vec<ToastNotification>> {
        static ALIVE: std::sync::OnceLock<Mutex<Vec<ToastNotification>>> = std::sync::OnceLock::new();
        ALIVE.get_or_init(Default::default)
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn set_value(key: windows_sys::Win32::System::Registry::HKEY, name: &str, value: &str) {
        use windows_sys::Win32::System::Registry::{RegSetValueExW, REG_SZ};
        let v = wide(value);
        unsafe {
            RegSetValueExW(key, wide(name).as_ptr(), 0, REG_SZ, v.as_ptr() as *const u8, (v.len() * 2) as u32);
        }
    }

    pub fn register(icon: Option<&std::path::Path>) {
        use windows_sys::Win32::System::Registry::{RegCloseKey, RegCreateKeyExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE, REG_OPTION_NON_VOLATILE};
        let path = wide(&format!("Software\\Classes\\AppUserModelId\\{AUMID}"));
        let mut key: HKEY = 0;
        unsafe {
            if RegCreateKeyExW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            ) == 0
            {
                set_value(key, "DisplayName", "Nexterm");
                if let Some(icon) = icon {
                    set_value(key, "IconUri", &icon.to_string_lossy());
                }
                RegCloseKey(key);
            }
            windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(wide(AUMID).as_ptr());
        }
    }

    pub fn show(app: AppHandle, title: &str, body: &str, tag: &str) -> windows::core::Result<()> {
        show_with(title, body, tag, move |tag| {
            let _ = app.emit("notification-clicked", NotificationClick { tag });
        })
    }

    pub fn show_with(
        title: &str,
        body: &str,
        tag: &str,
        on_click: impl Fn(String) + Send + Sync + 'static,
    ) -> windows::core::Result<()> {
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(toast_xml(title, body, tag)))?;
        let toast = ToastNotification::CreateToastNotification(&xml)?;
        // One toast per pane: a newer state replaces the older one in the Action Center.
        let short: String = tag.chars().filter(|c| c.is_ascii_alphanumeric()).rev().take(60).collect::<String>().chars().rev().collect();
        let _ = toast.SetTag(&HSTRING::from(short));
        let _ = toast.SetGroup(&HSTRING::from("agent"));
        toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, args| {
            let tag = args
                .as_ref()
                .and_then(|a| a.cast::<ToastActivatedEventArgs>().ok())
                .and_then(|a| a.Arguments().ok())
                .map(|s| s.to_string())
                .unwrap_or_default();
            on_click(tag);
            Ok(())
        }))?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))?.Show(&toast)?;
        if let Ok(mut list) = alive().lock() {
            list.push(toast);
            let n = list.len();
            if n > 16 {
                list.drain(0..n - 16);
            }
        }
        Ok(())
    }
}

/// Register the app for toasts (call once at start-up; writes the icon next to the data).
pub fn init(data_dir: &std::path::Path) {
    #[cfg(windows)]
    {
        let icon = data_dir.join("notify-icon.png");
        let ok = std::fs::write(&icon, include_bytes!("../icons/128x128.png")).is_ok();
        imp::register(ok.then_some(icon.as_path()));
    }
    #[cfg(not(windows))]
    {
        let _ = data_dir;
    }
}

/// Like [`show`], but a click first brings the main window back (from the tray, minimized,
/// behind other apps): for questions whose dialog waits in a window the user cannot see.
/// The click is still emitted as `notification-clicked` with `tag` afterwards.
pub fn show_reveal(app: &AppHandle, title: String, body: String, tag: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let click_app = handle.clone();
            let shown = imp::show_with(&title, &body, &tag, move |tag| {
                use tauri::{Emitter, Manager};
                let app = click_app.clone();
                let _ = click_app.run_on_main_thread(move || {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.unminimize();
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                    let _ = app.emit("notification-clicked", NotificationClick { tag });
                });
            });
            if let Err(e) = shown {
                eprintln!("toast failed: {e}");
            }
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, title, body, tag);
        Err("notifications are only implemented on Windows".into())
    }
}

/// Show a toast; runs on the main (UI / COM) thread.
pub fn show(app: &AppHandle, title: String, body: String, tag: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let handle = app.clone();
        app.run_on_main_thread(move || {
            if let Err(e) = imp::show(handle, &title, &body, &tag) {
                eprintln!("toast failed: {e}");
            }
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, title, body, tag);
        Err("notifications are only implemented on Windows".into())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn escapes_toast_text() {
        let x = super::toast_xml("Claude <Code>", "a & \"b\"", "pane-1");
        assert!(x.contains("Claude &lt;Code&gt;"));
        assert!(x.contains("a &amp; &quot;b&quot;"));
        assert!(x.contains(r#"launch="pane-1""#));
    }
}

#[cfg(all(test, windows))]
mod toast_tests {
    /// Shows a real toast: cargo test --offline real_toast -- --ignored
    #[test]
    #[ignore]
    fn real_toast() {
        super::imp::register(None);
        super::imp::show_with("Nexterm", "Claude Code finished - test", "pane-test", |_| {}).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}
