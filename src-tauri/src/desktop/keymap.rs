//! Keyboard mapping for remote desktop panes. The page sends the browser's
//! `KeyboardEvent.code` (physical key) and `key` (produced character).
//!
//! - RDP sends scan codes (set 1), so the remote keyboard layout decides the character,
//!   exactly like a local keyboard.
//! - VNC sends X11 keysyms: printable keys use the character the local layout produced,
//!   the others map by physical key.

/// Scan code (set 1) of a physical key: `(extended, code)`.
pub fn scancode(code: &str) -> Option<(bool, u8)> {
    let plain = |c: u8| Some((false, c));
    let ext = |c: u8| Some((true, c));
    match code {
        "Escape" => plain(0x01),
        "Digit1" => plain(0x02),
        "Digit2" => plain(0x03),
        "Digit3" => plain(0x04),
        "Digit4" => plain(0x05),
        "Digit5" => plain(0x06),
        "Digit6" => plain(0x07),
        "Digit7" => plain(0x08),
        "Digit8" => plain(0x09),
        "Digit9" => plain(0x0A),
        "Digit0" => plain(0x0B),
        "Minus" => plain(0x0C),
        "Equal" => plain(0x0D),
        "Backspace" => plain(0x0E),
        "Tab" => plain(0x0F),
        "KeyQ" => plain(0x10),
        "KeyW" => plain(0x11),
        "KeyE" => plain(0x12),
        "KeyR" => plain(0x13),
        "KeyT" => plain(0x14),
        "KeyY" => plain(0x15),
        "KeyU" => plain(0x16),
        "KeyI" => plain(0x17),
        "KeyO" => plain(0x18),
        "KeyP" => plain(0x19),
        "BracketLeft" => plain(0x1A),
        "BracketRight" => plain(0x1B),
        "Enter" => plain(0x1C),
        "ControlLeft" => plain(0x1D),
        "KeyA" => plain(0x1E),
        "KeyS" => plain(0x1F),
        "KeyD" => plain(0x20),
        "KeyF" => plain(0x21),
        "KeyG" => plain(0x22),
        "KeyH" => plain(0x23),
        "KeyJ" => plain(0x24),
        "KeyK" => plain(0x25),
        "KeyL" => plain(0x26),
        "Semicolon" => plain(0x27),
        "Quote" => plain(0x28),
        "Backquote" => plain(0x29),
        "ShiftLeft" => plain(0x2A),
        "Backslash" => plain(0x2B),
        "KeyZ" => plain(0x2C),
        "KeyX" => plain(0x2D),
        "KeyC" => plain(0x2E),
        "KeyV" => plain(0x2F),
        "KeyB" => plain(0x30),
        "KeyN" => plain(0x31),
        "KeyM" => plain(0x32),
        "Comma" => plain(0x33),
        "Period" => plain(0x34),
        "Slash" => plain(0x35),
        "ShiftRight" => plain(0x36),
        "NumpadMultiply" => plain(0x37),
        "AltLeft" => plain(0x38),
        "Space" => plain(0x39),
        "CapsLock" => plain(0x3A),
        "F1" => plain(0x3B),
        "F2" => plain(0x3C),
        "F3" => plain(0x3D),
        "F4" => plain(0x3E),
        "F5" => plain(0x3F),
        "F6" => plain(0x40),
        "F7" => plain(0x41),
        "F8" => plain(0x42),
        "F9" => plain(0x43),
        "F10" => plain(0x44),
        "NumLock" => plain(0x45),
        "ScrollLock" => plain(0x46),
        "Numpad7" => plain(0x47),
        "Numpad8" => plain(0x48),
        "Numpad9" => plain(0x49),
        "NumpadSubtract" => plain(0x4A),
        "Numpad4" => plain(0x4B),
        "Numpad5" => plain(0x4C),
        "Numpad6" => plain(0x4D),
        "NumpadAdd" => plain(0x4E),
        "Numpad1" => plain(0x4F),
        "Numpad2" => plain(0x50),
        "Numpad3" => plain(0x51),
        "Numpad0" => plain(0x52),
        "NumpadDecimal" => plain(0x53),
        "IntlBackslash" => plain(0x56),
        "F11" => plain(0x57),
        "F12" => plain(0x58),
        "F13" => plain(0x64),
        "F14" => plain(0x65),
        "F15" => plain(0x66),
        "F16" => plain(0x67),
        "F17" => plain(0x68),
        "F18" => plain(0x69),
        "F19" => plain(0x6A),
        "F20" => plain(0x6B),
        "F21" => plain(0x6C),
        "F22" => plain(0x6D),
        "F23" => plain(0x6E),
        "F24" => plain(0x76),
        "KanaMode" => plain(0x70),
        "Lang2" => plain(0x71),
        "Lang1" => plain(0x72),
        "IntlRo" => plain(0x73),
        "Convert" => plain(0x79),
        "NonConvert" => plain(0x7B),
        "IntlYen" => plain(0x7D),
        "NumpadEqual" => plain(0x59),
        "NumpadComma" => plain(0x7E),
        "MediaTrackPrevious" => ext(0x10),
        "MediaTrackNext" => ext(0x19),
        "NumpadEnter" => ext(0x1C),
        "ControlRight" => ext(0x1D),
        "AudioVolumeMute" => ext(0x20),
        "LaunchApp2" => ext(0x21),
        "MediaPlayPause" => ext(0x22),
        "MediaStop" => ext(0x24),
        "AudioVolumeDown" => ext(0x2E),
        "AudioVolumeUp" => ext(0x30),
        "BrowserHome" => ext(0x32),
        "NumpadDivide" => ext(0x35),
        "PrintScreen" => ext(0x37),
        "AltRight" => ext(0x38),
        "Home" => ext(0x47),
        "ArrowUp" => ext(0x48),
        "PageUp" => ext(0x49),
        "ArrowLeft" => ext(0x4B),
        "ArrowRight" => ext(0x4D),
        "End" => ext(0x4F),
        "ArrowDown" => ext(0x50),
        "PageDown" => ext(0x51),
        "Insert" => ext(0x52),
        "Delete" => ext(0x53),
        "MetaLeft" | "OSLeft" => ext(0x5B),
        "MetaRight" | "OSRight" => ext(0x5C),
        "ContextMenu" => ext(0x5D),
        "BrowserSearch" => ext(0x65),
        "BrowserFavorites" => ext(0x66),
        "BrowserRefresh" => ext(0x67),
        "BrowserStop" => ext(0x68),
        "BrowserForward" => ext(0x69),
        "BrowserBack" => ext(0x6A),
        "LaunchApp1" => ext(0x6B),
        "LaunchMail" => ext(0x6C),
        "MediaSelect" => ext(0x6D),
        _ => None,
    }
}

/// X11 keysym for a key press (VNC). `key` is the character the local layout produced.
pub fn keysym(code: &str, key: &str) -> Option<u32> {
    // Keypad and the non-printing keys go by physical key, so NumLock and
    // modifiers behave on the remote side as they do on a real keyboard.
    if let Some(sym) = function_keysym(code) {
        return Some(sym);
    }
    let mut chars = key.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => Some(char_keysym(c)),
        _ => None,
    }
}

/// Keysym of a character: Latin-1 maps to itself, anything else to the Unicode range.
pub fn char_keysym(c: char) -> u32 {
    let cp = c as u32;
    match cp {
        0x20..=0x7E | 0xA0..=0xFF => cp,
        _ => 0x0100_0000 + cp,
    }
}

fn function_keysym(code: &str) -> Option<u32> {
    Some(match code {
        "Backspace" => 0xFF08,
        "Tab" => 0xFF09,
        "Enter" => 0xFF0D,
        "Pause" => 0xFF13,
        "ScrollLock" => 0xFF14,
        "Escape" => 0xFF1B,
        "Delete" => 0xFFFF,
        "Home" => 0xFF50,
        "ArrowLeft" => 0xFF51,
        "ArrowUp" => 0xFF52,
        "ArrowRight" => 0xFF53,
        "ArrowDown" => 0xFF54,
        "PageUp" => 0xFF55,
        "PageDown" => 0xFF56,
        "End" => 0xFF57,
        "PrintScreen" => 0xFF61,
        "Insert" => 0xFF63,
        "ContextMenu" => 0xFF67,
        "NumLock" => 0xFF7F,
        "NumpadEnter" => 0xFF8D,
        "NumpadMultiply" => 0xFFAA,
        "NumpadAdd" => 0xFFAB,
        "NumpadSubtract" => 0xFFAD,
        "NumpadDecimal" => 0xFFAE,
        "NumpadDivide" => 0xFFAF,
        "Numpad0" => 0xFFB0,
        "Numpad1" => 0xFFB1,
        "Numpad2" => 0xFFB2,
        "Numpad3" => 0xFFB3,
        "Numpad4" => 0xFFB4,
        "Numpad5" => 0xFFB5,
        "Numpad6" => 0xFFB6,
        "Numpad7" => 0xFFB7,
        "Numpad8" => 0xFFB8,
        "Numpad9" => 0xFFB9,
        "NumpadEqual" => 0xFFBD,
        "F1" => 0xFFBE,
        "F2" => 0xFFBF,
        "F3" => 0xFFC0,
        "F4" => 0xFFC1,
        "F5" => 0xFFC2,
        "F6" => 0xFFC3,
        "F7" => 0xFFC4,
        "F8" => 0xFFC5,
        "F9" => 0xFFC6,
        "F10" => 0xFFC7,
        "F11" => 0xFFC8,
        "F12" => 0xFFC9,
        "ShiftLeft" => 0xFFE1,
        "ShiftRight" => 0xFFE2,
        "ControlLeft" => 0xFFE3,
        "ControlRight" => 0xFFE4,
        "CapsLock" => 0xFFE5,
        "AltLeft" => 0xFFE9,
        "AltRight" => 0xFFEA,
        "MetaLeft" | "OSLeft" => 0xFFEB,
        "MetaRight" | "OSRight" => 0xFFEC,
        _ => return None,
    })
}

pub const KEYSYM_CONTROL_L: u32 = 0xFFE3;
pub const KEYSYM_ALT_L: u32 = 0xFFE9;
pub const KEYSYM_DELETE: u32 = 0xFFFF;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scancodes_cover_letters_and_extended_keys() {
        assert_eq!(scancode("KeyA"), Some((false, 0x1E)));
        assert_eq!(scancode("Digit0"), Some((false, 0x0B)));
        assert_eq!(scancode("Enter"), Some((false, 0x1C)));
        assert_eq!(scancode("NumpadEnter"), Some((true, 0x1C)));
        assert_eq!(scancode("ArrowLeft"), Some((true, 0x4B)));
        assert_eq!(scancode("Numpad4"), Some((false, 0x4B)));
        assert_eq!(scancode("MetaLeft"), Some((true, 0x5B)));
        assert_eq!(scancode("Unidentified"), None);
        // Every letter and digit maps, and no two keys share a scan code.
        let codes: Vec<String> = ('A'..='Z')
            .map(|c| format!("Key{c}"))
            .chain((0..10).map(|d| format!("Digit{d}")))
            .collect();
        let mut seen = std::collections::HashSet::new();
        for c in &codes {
            assert!(seen.insert(scancode(c).unwrap()), "{c} repeats a scan code");
        }
    }

    #[test]
    fn keysyms_use_layout_characters_and_physical_specials() {
        assert_eq!(keysym("KeyA", "a"), Some(0x61));
        assert_eq!(keysym("KeyA", "A"), Some(0x41));
        // A French layout's Digit2 produces é (Latin-1 keeps its code point).
        assert_eq!(keysym("Digit2", "é"), Some(0xE9));
        assert_eq!(keysym("KeyQ", "й"), Some(0x0100_0439));
        assert_eq!(keysym("Enter", "Enter"), Some(0xFF0D));
        // The keypad goes by key even when NumLock produces a digit.
        assert_eq!(keysym("Numpad1", "1"), Some(0xFFB1));
        assert_eq!(keysym("ShiftLeft", "Shift"), Some(0xFFE1));
        assert_eq!(keysym("Unidentified", "Process"), None);
    }
}
