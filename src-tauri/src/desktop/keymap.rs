//! Keyboard mapping for remote desktop panes. The page sends the browser's
//! `KeyboardEvent.code` (physical key) and `key` (produced character).
//!
//! - RDP sends scan codes (set 1), so the remote keyboard layout decides the character,
//!   exactly like a local keyboard.
//! - VNC sends X11 keysyms: printable keys use the character the local layout produced,
//!   the others map by physical key.

/// Physical keys by `KeyboardEvent.code` and their scan code (set 1): `(code, extended, scan code)`.
const SCANCODES: &[(&str, bool, u8)] = &[
    ("Escape", false, 0x01),
    ("Digit1", false, 0x02),
    ("Digit2", false, 0x03),
    ("Digit3", false, 0x04),
    ("Digit4", false, 0x05),
    ("Digit5", false, 0x06),
    ("Digit6", false, 0x07),
    ("Digit7", false, 0x08),
    ("Digit8", false, 0x09),
    ("Digit9", false, 0x0A),
    ("Digit0", false, 0x0B),
    ("Minus", false, 0x0C),
    ("Equal", false, 0x0D),
    ("Backspace", false, 0x0E),
    ("Tab", false, 0x0F),
    ("KeyQ", false, 0x10),
    ("KeyW", false, 0x11),
    ("KeyE", false, 0x12),
    ("KeyR", false, 0x13),
    ("KeyT", false, 0x14),
    ("KeyY", false, 0x15),
    ("KeyU", false, 0x16),
    ("KeyI", false, 0x17),
    ("KeyO", false, 0x18),
    ("KeyP", false, 0x19),
    ("BracketLeft", false, 0x1A),
    ("BracketRight", false, 0x1B),
    ("Enter", false, 0x1C),
    ("ControlLeft", false, 0x1D),
    ("KeyA", false, 0x1E),
    ("KeyS", false, 0x1F),
    ("KeyD", false, 0x20),
    ("KeyF", false, 0x21),
    ("KeyG", false, 0x22),
    ("KeyH", false, 0x23),
    ("KeyJ", false, 0x24),
    ("KeyK", false, 0x25),
    ("KeyL", false, 0x26),
    ("Semicolon", false, 0x27),
    ("Quote", false, 0x28),
    ("Backquote", false, 0x29),
    ("ShiftLeft", false, 0x2A),
    ("Backslash", false, 0x2B),
    ("KeyZ", false, 0x2C),
    ("KeyX", false, 0x2D),
    ("KeyC", false, 0x2E),
    ("KeyV", false, 0x2F),
    ("KeyB", false, 0x30),
    ("KeyN", false, 0x31),
    ("KeyM", false, 0x32),
    ("Comma", false, 0x33),
    ("Period", false, 0x34),
    ("Slash", false, 0x35),
    ("ShiftRight", false, 0x36),
    ("NumpadMultiply", false, 0x37),
    ("AltLeft", false, 0x38),
    ("Space", false, 0x39),
    ("CapsLock", false, 0x3A),
    ("F1", false, 0x3B),
    ("F2", false, 0x3C),
    ("F3", false, 0x3D),
    ("F4", false, 0x3E),
    ("F5", false, 0x3F),
    ("F6", false, 0x40),
    ("F7", false, 0x41),
    ("F8", false, 0x42),
    ("F9", false, 0x43),
    ("F10", false, 0x44),
    ("NumLock", false, 0x45),
    ("ScrollLock", false, 0x46),
    ("Numpad7", false, 0x47),
    ("Numpad8", false, 0x48),
    ("Numpad9", false, 0x49),
    ("NumpadSubtract", false, 0x4A),
    ("Numpad4", false, 0x4B),
    ("Numpad5", false, 0x4C),
    ("Numpad6", false, 0x4D),
    ("NumpadAdd", false, 0x4E),
    ("Numpad1", false, 0x4F),
    ("Numpad2", false, 0x50),
    ("Numpad3", false, 0x51),
    ("Numpad0", false, 0x52),
    ("NumpadDecimal", false, 0x53),
    ("IntlBackslash", false, 0x56),
    ("F11", false, 0x57),
    ("F12", false, 0x58),
    ("F13", false, 0x64),
    ("F14", false, 0x65),
    ("F15", false, 0x66),
    ("F16", false, 0x67),
    ("F17", false, 0x68),
    ("F18", false, 0x69),
    ("F19", false, 0x6A),
    ("F20", false, 0x6B),
    ("F21", false, 0x6C),
    ("F22", false, 0x6D),
    ("F23", false, 0x6E),
    ("F24", false, 0x76),
    ("KanaMode", false, 0x70),
    ("Lang2", false, 0x71),
    ("Lang1", false, 0x72),
    ("IntlRo", false, 0x73),
    ("Convert", false, 0x79),
    ("NonConvert", false, 0x7B),
    ("IntlYen", false, 0x7D),
    ("NumpadEqual", false, 0x59),
    ("NumpadComma", false, 0x7E),
    ("MediaTrackPrevious", true, 0x10),
    ("MediaTrackNext", true, 0x19),
    ("NumpadEnter", true, 0x1C),
    ("ControlRight", true, 0x1D),
    ("AudioVolumeMute", true, 0x20),
    ("LaunchApp2", true, 0x21),
    ("MediaPlayPause", true, 0x22),
    ("MediaStop", true, 0x24),
    ("AudioVolumeDown", true, 0x2E),
    ("AudioVolumeUp", true, 0x30),
    ("BrowserHome", true, 0x32),
    ("NumpadDivide", true, 0x35),
    ("PrintScreen", true, 0x37),
    ("AltRight", true, 0x38),
    ("Home", true, 0x47),
    ("ArrowUp", true, 0x48),
    ("PageUp", true, 0x49),
    ("ArrowLeft", true, 0x4B),
    ("ArrowRight", true, 0x4D),
    ("End", true, 0x4F),
    ("ArrowDown", true, 0x50),
    ("PageDown", true, 0x51),
    ("Insert", true, 0x52),
    ("Delete", true, 0x53),
    ("MetaLeft", true, 0x5B),
    ("MetaRight", true, 0x5C),
    ("ContextMenu", true, 0x5D),
    ("BrowserSearch", true, 0x65),
    ("BrowserFavorites", true, 0x66),
    ("BrowserRefresh", true, 0x67),
    ("BrowserStop", true, 0x68),
    ("BrowserForward", true, 0x69),
    ("BrowserBack", true, 0x6A),
    ("LaunchApp1", true, 0x6B),
    ("LaunchMail", true, 0x6C),
    ("MediaSelect", true, 0x6D),
];

/// Scan code (set 1) of a physical key: `(extended, code)`.
pub fn scancode(code: &str) -> Option<(bool, u8)> {
    let code = match code {
        // Older browsers' names for the Windows keys.
        "OSLeft" => "MetaLeft",
        "OSRight" => "MetaRight",
        c => c,
    };
    SCANCODES.iter().find(|(c, ..)| *c == code).map(|&(_, ext, sc)| (ext, sc))
}

/// The physical key of a scan code (what the keyboard hook sees), if it has a name here.
pub fn code_for_scancode(extended: bool, scancode: u8) -> Option<&'static str> {
    SCANCODES.iter().find(|&&(_, e, sc)| e == extended && sc == scancode).map(|&(c, ..)| c)
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
        // No character (keys the keyboard hook takes before the page sees them, such as
        // Win+E): the key's US layout character.
        (None, _) => us_char(code).map(char_keysym),
        _ => None,
    }
}

fn us_char(code: &str) -> Option<char> {
    if code == "Space" {
        return Some(' ');
    }
    let (prefix, rest) = code.split_at(code.len().saturating_sub(1));
    let c = rest.chars().next()?;
    match prefix {
        "Key" if c.is_ascii_uppercase() => Some(c.to_ascii_lowercase()),
        "Digit" if c.is_ascii_digit() => Some(c),
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
        // Without a character (Win+E from the keyboard hook): the US layout's.
        assert_eq!(keysym("KeyE", ""), Some(0x65));
        assert_eq!(keysym("Digit3", ""), Some(0x33));
        assert_eq!(keysym("Space", ""), Some(0x20));
        assert_eq!(keysym("Minus", ""), None);
    }

    #[test]
    fn scan_codes_map_back_to_keys() {
        assert_eq!(code_for_scancode(true, 0x5B), Some("MetaLeft"));
        assert_eq!(code_for_scancode(false, 0x0F), Some("Tab"));
        assert_eq!(code_for_scancode(true, 0x37), Some("PrintScreen"));
        assert_eq!(code_for_scancode(false, 0x37), Some("NumpadMultiply"));
        assert_eq!(code_for_scancode(true, 0x01), None);
        assert_eq!(scancode("OSLeft"), scancode("MetaLeft"));
        // Every key round-trips: no two keys share a scan code.
        for &(code, ext, sc) in SCANCODES {
            assert_eq!(code_for_scancode(ext, sc), Some(code), "{code}");
        }
    }
}
