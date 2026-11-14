//! Remote character sets (GBK, Big5, Shift_JIS ...) converted to / from the UTF-8
//! the terminal speaks, using the Windows code page tables.

/// Charset names offered in the UI, with their Windows code pages.
pub const CHARSETS: &[(&str, u32)] = &[
    ("UTF-8", 65001),
    ("GBK", 936),
    ("GB2312", 936),
    ("GB18030", 54936),
    ("Big5", 950),
    ("Shift_JIS", 932),
    ("EUC-JP", 20932),
    ("EUC-KR", 949),
    ("ISO-8859-1", 28591),
    ("ISO-8859-2", 28592),
    ("ISO-8859-5", 28595),
    ("ISO-8859-15", 28605),
    ("KOI8-R", 20866),
    ("Windows-1250", 1250),
    ("Windows-1251", 1251),
    ("Windows-1252", 1252),
    ("CP437", 437),
    ("CP866", 866),
];

/// Value for the remote LANG, like WindTerm: "<user locale>.<charset>", e.g. zh_CN.UTF-8.
/// Without it a server that has no locale of its own (JumpServer, busybox, dropbear ...)
/// falls back to a byte-oriented "C" locale and mishandles wide characters such as 中文.
pub fn remote_lang(charset: &str) -> String {
    let cs = charset.trim();
    let suffix = match cs.to_ascii_uppercase().replace('_', "-").as_str() {
        "" | "UTF-8" | "UTF8" => "UTF-8".to_string(),
        "BIG5" => "BIG5".to_string(),
        "SHIFT-JIS" => "SJIS".to_string(),
        "EUC-JP" => "eucJP".to_string(),
        "EUC-KR" => "eucKR".to_string(),
        _ => cs.to_string(),
    };
    format!("{}.{}", user_locale(), suffix)
}

#[cfg(windows)]
fn user_locale() -> String {
    use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;
    let mut buf = [0u16; 85];
    let n = unsafe { GetUserDefaultLocaleName(buf.as_mut_ptr(), buf.len() as i32) };
    let name = if n > 1 { String::from_utf16_lossy(&buf[..(n - 1) as usize]) } else { String::new() };
    // "zh-CN" -> "zh_CN"; scripts like "zh-Hans-CN" keep language + region.
    let parts: Vec<&str> = name.split('-').collect();
    match (parts.first(), parts.last()) {
        (Some(lang), Some(region)) if parts.len() >= 2 && lang.len() == 2 && region.len() == 2 => {
            format!("{}_{}", lang.to_ascii_lowercase(), region.to_ascii_uppercase())
        }
        _ => "en_US".to_string(),
    }
}

#[cfg(not(windows))]
fn user_locale() -> String {
    "en_US".to_string()
}

fn code_page(name: &str) -> Option<u32> {
    let n = name.trim();
    if n.is_empty() {
        return None;
    }
    CHARSETS
        .iter()
        .find(|(label, _)| label.eq_ignore_ascii_case(n) || label.replace(['-', '_'], "").eq_ignore_ascii_case(&n.replace(['-', '_'], "")))
        .map(|(_, cp)| *cp)
        .filter(|cp| *cp != 65001)
}

/// Converts one session's byte stream. UTF-8 sessions pass through untouched.
pub struct Codec {
    cp: Option<u32>,
    /// Incomplete multi-byte sequence carried to the next chunk.
    pending: Vec<u8>,
}

impl Codec {
    pub fn new(charset: &str) -> Self {
        Self { cp: code_page(charset), pending: Vec::new() }
    }

    pub fn is_passthrough(&self) -> bool {
        self.cp.is_none()
    }

    /// Remote bytes -> UTF-8.
    pub fn decode(&mut self, input: &[u8]) -> Vec<u8> {
        let Some(cp) = self.cp else {
            return input.to_vec();
        };
        let mut data = std::mem::take(&mut self.pending);
        data.extend_from_slice(input);
        let complete = complete_len(cp, &data);
        self.pending = data[complete..].to_vec();
        if self.pending.len() > 4 {
            // Never hold more than one character back.
            self.pending.clear();
        }
        decode_cp(cp, &data[..complete]).into_bytes()
    }

    /// UTF-8 from the terminal -> remote bytes.
    pub fn encode(&self, input: &[u8]) -> Vec<u8> {
        let Some(cp) = self.cp else {
            return input.to_vec();
        };
        if input.is_ascii() {
            return input.to_vec();
        }
        encode_cp(cp, &String::from_utf8_lossy(input))
    }
}

/// Length of the prefix of `data` that ends on a character boundary.
fn complete_len(cp: u32, data: &[u8]) -> usize {
    if cp == 54936 {
        return gb18030_complete_len(data);
    }
    if !is_dbcs(cp) {
        return data.len();
    }
    let mut i = 0;
    while i < data.len() {
        if data[i] >= 0x80 && is_lead_byte(cp, data[i]) {
            if i + 1 >= data.len() {
                return i;
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    data.len()
}

fn gb18030_complete_len(data: &[u8]) -> usize {
    let mut i = 0;
    while i < data.len() {
        let b = data[i];
        if (0x81..=0xFE).contains(&b) {
            let Some(&b2) = data.get(i + 1) else { return i };
            if (0x30..=0x39).contains(&b2) {
                if i + 3 >= data.len() {
                    return i;
                }
                i += 4;
            } else {
                i += 2;
            }
        } else {
            i += 1;
        }
    }
    data.len()
}

fn is_dbcs(cp: u32) -> bool {
    matches!(cp, 932 | 936 | 949 | 950 | 20932)
}

#[cfg(windows)]
fn is_lead_byte(cp: u32, b: u8) -> bool {
    if cp == 20932 {
        // EUC-JP: 0x8E / 0x8F introduce 2 / 3 byte sequences; treat as lead bytes.
        return b >= 0x8E;
    }
    unsafe { windows_sys::Win32::Globalization::IsDBCSLeadByteEx(cp, b) != 0 }
}

#[cfg(windows)]
fn decode_cp(cp: u32, bytes: &[u8]) -> String {
    use windows_sys::Win32::Globalization::MultiByteToWideChar;
    if bytes.is_empty() {
        return String::new();
    }
    unsafe {
        let n = MultiByteToWideChar(cp, 0, bytes.as_ptr(), bytes.len() as i32, std::ptr::null_mut(), 0);
        if n <= 0 {
            return String::from_utf8_lossy(bytes).to_string();
        }
        let mut wide = vec![0u16; n as usize];
        MultiByteToWideChar(cp, 0, bytes.as_ptr(), bytes.len() as i32, wide.as_mut_ptr(), n);
        String::from_utf16_lossy(&wide)
    }
}

#[cfg(windows)]
fn encode_cp(cp: u32, text: &str) -> Vec<u8> {
    use windows_sys::Win32::Globalization::WideCharToMultiByte;
    let wide: Vec<u16> = text.encode_utf16().collect();
    if wide.is_empty() {
        return Vec::new();
    }
    unsafe {
        let n = WideCharToMultiByte(cp, 0, wide.as_ptr(), wide.len() as i32, std::ptr::null_mut(), 0, std::ptr::null(), std::ptr::null_mut());
        if n <= 0 {
            return text.as_bytes().to_vec();
        }
        let mut out = vec![0u8; n as usize];
        WideCharToMultiByte(cp, 0, wide.as_ptr(), wide.len() as i32, out.as_mut_ptr(), n, std::ptr::null(), std::ptr::null_mut());
        out
    }
}

#[cfg(not(windows))]
fn is_lead_byte(_cp: u32, b: u8) -> bool {
    b >= 0x81
}

#[cfg(not(windows))]
fn decode_cp(_cp: u32, bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).to_string()
}

#[cfg(not(windows))]
fn encode_cp(_cp: u32, text: &str) -> Vec<u8> {
    text.as_bytes().to_vec()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn test_gbk_round_trip_split_across_chunks() {
        let mut c = Codec::new("GBK");
        // "中文 ok" in GBK, split in the middle of 文.
        let gbk = [0xD6, 0xD0, 0xCE, 0xC4, b' ', b'o', b'k'];
        let mut out = c.decode(&gbk[..3]);
        out.extend(c.decode(&gbk[3..]));
        assert_eq!(String::from_utf8(out).unwrap(), "中文 ok");
        assert_eq!(c.encode("中文 ok".as_bytes()), gbk.to_vec());
        assert!(Codec::new("utf8").is_passthrough());
        assert!(Codec::new("").is_passthrough());
    }

    #[test]
    fn test_remote_lang() {
        let l = remote_lang("");
        assert!(l.ends_with(".UTF-8") && l.contains('_'), "{}", l);
        assert!(remote_lang("GBK").ends_with(".GBK"));
        assert!(remote_lang("Shift_JIS").ends_with(".SJIS"));
    }

    #[test]
    fn test_gb18030_four_byte() {
        let mut c = Codec::new("GB18030");
        let bytes = encode_cp(54936, "€😀");
        let mut out = Vec::new();
        for b in &bytes {
            out.extend(c.decode(&[*b]));
        }
        assert_eq!(String::from_utf8(out).unwrap(), "€😀");
    }
}
