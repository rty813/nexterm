//! Windows key combinations for remote desktop panes.
//!
//! Win+X, Win+R, Alt+Tab, Ctrl+Esc and the like are handled by Windows before the page
//! sees a `keydown`, so they used to act on this computer instead of the remote one. While
//! a desktop pane wants them (it has focus, and the session's `windowsKeys` setting says so)
//! a low-level keyboard hook takes those keys away from Windows and sends them straight
//! to the session, like mstsc does. Everything else still reaches the page as usual (input
//! methods keep working). Win+L and Ctrl+Alt+Del cannot be taken: Windows handles them below
//! any hook.
//!
//! The hook lives on a thread of its own with a message loop, installed only while a pane
//! captures and removed as soon as it stops.
//!
//! Windows does not call a process's own low-level keyboard hook while a window of that
//! process is in front and registered for raw keyboard input, which tao does by default:
//! `lib.rs` turns that off (`device_event_filter`). Without it the hook sees every key
//! except the ones typed into this app.

use tokio::sync::mpsc::UnboundedSender;

use super::Control;

const VK_TAB: u32 = 0x09;
const VK_ESCAPE: u32 = 0x1B;
const VK_SPACE: u32 = 0x20;
const VK_SNAPSHOT: u32 = 0x2C;
const VK_L: u32 = 0x4C;
const VK_LWIN: u32 = 0x5B;
const VK_RWIN: u32 = 0x5C;
const VK_F4: u32 = 0x73;

/// Decides which key events go to the remote side instead of Windows. A key taken when
/// pressed is also taken when released, so presses and releases always stay in pairs on
/// each side.
#[derive(Default)]
pub(crate) struct Grabber {
    /// Virtual keys whose press went to the remote side and are still held.
    taken: Vec<u32>,
}

impl Grabber {
    /// `ctrl` / `alt`: whether those modifiers are held (they reach the remote side through
    /// the page; only the key that makes the combination is taken here).
    pub fn take(&mut self, vk: u32, down: bool, ctrl: bool, alt: bool) -> bool {
        let held = self.taken.iter().position(|&k| k == vk);
        if !down {
            if let Some(i) = held {
                self.taken.swap_remove(i);
                return true;
            }
            return false;
        }
        if held.is_some() {
            // Auto-repeat of a key already taken.
            return true;
        }
        let win = self.taken.iter().any(|&k| k == VK_LWIN || k == VK_RWIN);
        let take = match vk {
            VK_LWIN | VK_RWIN => true,
            // Win+L locks this computer whatever a hook does; don't lock the remote one too.
            VK_L if win => false,
            // Win+anything (Win+X, Win+Shift+S, ...).
            _ if win => true,
            // Alt+Tab, Alt+Esc, Alt+F4, Alt+Space (window menu).
            VK_TAB | VK_ESCAPE | VK_F4 | VK_SPACE if alt => true,
            // Ctrl+Esc (Start), Ctrl+Shift+Esc (Task Manager).
            VK_ESCAPE if ctrl => true,
            // Print Screen (the snipping tool on Windows 11); the page never gets its press.
            VK_SNAPSHOT => true,
            _ => false,
        };
        if take {
            self.taken.push(vk);
        }
        take
    }
}

/// The pane that takes the keys.
struct Capture {
    instance_id: String,
    /// Its window: keys are taken only while that window is in front.
    hwnd: isize,
    tx: UnboundedSender<Control>,
    grabber: Grabber,
    /// The hook thread (to stop it).
    thread: u32,
}

static CAPTURE: std::sync::Mutex<Option<Capture>> = std::sync::Mutex::new(None);

fn lock() -> std::sync::MutexGuard<'static, Option<Capture>> {
    CAPTURE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Start taking Windows key combinations for this pane (instead of any other pane).
pub(crate) fn capture(instance_id: &str, hwnd: isize, tx: UnboundedSender<Control>) {
    let mut guard = lock();
    if let Some(c) = guard.as_mut() {
        if c.instance_id != instance_id {
            c.grabber = Grabber::default();
        }
        c.instance_id = instance_id.to_string();
        c.hwnd = hwnd;
        c.tx = tx;
        return;
    }
    let Some(thread) = win::start() else { return };
    *guard = Some(Capture { instance_id: instance_id.to_string(), hwnd, tx, grabber: Grabber::default(), thread });
}

/// The pane's session was replaced (reconnect): keys go to the new one.
pub(crate) fn retarget(instance_id: &str, tx: &UnboundedSender<Control>) {
    if let Some(c) = lock().as_mut().filter(|c| c.instance_id == instance_id) {
        c.tx = tx.clone();
    }
}

/// Stop taking keys for this pane (nothing happens if another pane took over since).
pub(crate) fn release(instance_id: &str) {
    let mut guard = lock();
    if guard.as_ref().is_some_and(|c| c.instance_id == instance_id) {
        if let Some(c) = guard.take() {
            win::stop(c.thread);
        }
    }
}

#[cfg(windows)]
mod win {
    use std::ptr::null;
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetForegroundWindow, GetMessageW, PeekMessageW, PostThreadMessageW, SetWindowsHookExW,
        UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_ALTDOWN, LLKHF_EXTENDED, LLKHF_INJECTED, MSG,
        PM_NOREMOVE, WH_KEYBOARD_LL, WM_KEYDOWN, WM_QUIT, WM_SYSKEYDOWN,
    };

    use super::super::{keymap, Control, InputEvent};
    use super::{lock, VK_LWIN, VK_RWIN, VK_SNAPSHOT};

    /// Install the hook on a new thread; its thread id, or `None` when it could not be installed.
    pub fn start() -> Option<u32> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("desktop-keys".into())
            .spawn(move || unsafe {
                // Create the thread's message queue before anyone posts WM_QUIT to it, and
                // before the hook exists: pumping messages runs the hook, which takes the
                // lock `capture` holds until this thread reports back.
                let mut msg: MSG = std::mem::zeroed();
                PeekMessageW(&mut msg, 0, 0, 0, PM_NOREMOVE);
                let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), GetModuleHandleW(null()), 0);
                if hook == 0 {
                    eprintln!("[desktop] keyboard hook: {}", std::io::Error::last_os_error());
                    let _ = tx.send(None);
                    return;
                }
                if tx.send(Some(GetCurrentThreadId())).is_err() {
                    UnhookWindowsHookEx(hook);
                    return;
                }
                // Low-level hooks are called from this loop.
                while GetMessageW(&mut msg, 0, 0, 0) > 0 {}
                UnhookWindowsHookEx(hook);
            })
            .ok()?;
        rx.recv_timeout(Duration::from_secs(2)).ok().flatten()
    }

    pub fn stop(thread: u32) {
        unsafe {
            PostThreadMessageW(thread, WM_QUIT, 0, 0);
        }
    }

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 && take(&*(lparam as *const KBDLLHOOKSTRUCT), wparam as u32) {
            // Windows never sees this key.
            return 1;
        }
        CallNextHookEx(0, code, wparam, lparam)
    }

    /// Whether the key goes to the pane's session instead of Windows (and send it there).
    /// Runs inside the hook: keep it short, Windows waits for it before any key goes anywhere.
    fn take(info: &KBDLLHOOKSTRUCT, msg: u32) -> bool {
        // Keys a program typed (including other remote / automation tools) stay local.
        if info.flags & LLKHF_INJECTED != 0 {
            return false;
        }
        let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
        let mut guard = lock();
        let Some(c) = guard.as_mut() else { return false };
        if down && unsafe { GetForegroundWindow() } != c.hwnd {
            return false;
        }
        let ctrl = unsafe { GetAsyncKeyState(i32::from(VK_CONTROL)) } < 0;
        let alt = info.flags & LLKHF_ALTDOWN != 0;
        let Some(code) = event_code(info) else { return false };
        c.grabber.take(info.vkCode, down, ctrl, alt)
            && c.tx.send(Control::Input(vec![InputEvent::Key { code: code.to_string(), key: String::new(), down }])).is_ok()
    }

    /// The key as a `KeyboardEvent.code`. Resolved before the key is taken: a key the
    /// remote side has no code for must not disappear from both sides.
    fn event_code(info: &KBDLLHOOKSTRUCT) -> Option<&'static str> {
        let extended = info.flags & LLKHF_EXTENDED != 0;
        match info.vkCode {
            VK_LWIN => Some("MetaLeft"),
            VK_RWIN => Some("MetaRight"),
            VK_SNAPSHOT => Some("PrintScreen"),
            _ => u8::try_from(info.scanCode).ok().and_then(|sc| keymap::code_for_scancode(extended, sc)),
        }
    }
}

#[cfg(not(windows))]
mod win {
    pub fn start() -> Option<u32> {
        None
    }

    pub fn stop(_thread: u32) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    const VK_X: u32 = 0x58;
    const VK_SHIFT_L: u32 = 0xA0;
    const VK_A: u32 = 0x41;

    #[test]
    fn win_combinations_go_remote_in_pairs() {
        let mut g = Grabber::default();
        assert!(g.take(VK_LWIN, true, false, false));
        assert!(g.take(VK_LWIN, true, false, false), "auto-repeat");
        assert!(g.take(VK_SHIFT_L, true, false, false));
        assert!(g.take(VK_X, true, false, false));
        // Released after Win: still the remote side's key.
        assert!(g.take(VK_LWIN, false, false, false));
        assert!(g.take(VK_X, false, false, false));
        assert!(g.take(VK_SHIFT_L, false, false, false));
        // Win no longer held: plain keys stay with the page.
        assert!(!g.take(VK_X, true, false, false));
        assert!(!g.take(VK_X, false, false, false));
    }

    #[test]
    fn win_l_stays_local() {
        let mut g = Grabber::default();
        assert!(g.take(VK_RWIN, true, false, false));
        assert!(!g.take(VK_L, true, false, false));
        assert!(!g.take(VK_L, false, false, false));
        assert!(g.take(VK_RWIN, false, false, false));
    }

    #[test]
    fn alt_and_ctrl_combinations() {
        let mut g = Grabber::default();
        assert!(g.take(VK_TAB, true, false, true), "Alt+Tab");
        // Alt released before Tab: the release still goes where the press went.
        assert!(g.take(VK_TAB, false, false, false));
        assert!(!g.take(VK_TAB, true, false, false), "plain Tab");
        assert!(!g.take(VK_TAB, false, false, false));
        assert!(g.take(VK_F4, true, false, true), "Alt+F4");
        assert!(g.take(VK_F4, false, false, true));
        assert!(!g.take(VK_F4, true, false, false), "plain F4");
        assert!(g.take(VK_ESCAPE, true, true, false), "Ctrl+Esc");
        assert!(g.take(VK_ESCAPE, false, true, false));
        assert!(!g.take(VK_A, true, true, true), "Ctrl+Alt+A stays with the page");
        assert!(g.take(VK_SNAPSHOT, true, false, false));
        assert!(g.take(VK_SNAPSHOT, false, false, false));
    }
}
