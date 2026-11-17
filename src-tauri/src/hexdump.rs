//! Binary data type (WindTerm `session.dataType: binary`) for serial and raw TCP:
//! received bytes are shown as a hex dump instead of being run through the terminal.
//!
//! `00000010  48 65 6C 6C 6F 20 57 6F  72 6C 64 0D 0A 00 01 02  |Hello World.....|`
//!
//! A row is printed as soon as bytes arrive and redrawn (`\r` + erase line) while it
//! fills up, so the row must fit the pane: narrow panes get 8 or 4 bytes per row.

use std::fmt::Write as _;

const OFFSET: &str = "\x1b[90m";
const ASCII: &str = "\x1b[36m";
const RESET: &str = "\x1b[0m";

#[derive(Debug, Default)]
pub struct HexDump {
    /// Offset of the first byte of `row`.
    offset: u64,
    row: Vec<u8>,
    /// Bytes per row, fixed when a row starts.
    per_row: usize,
}

/// Text of one `feed`: for the pane, and the rows completed by it (plain, for the log).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct DumpOutput {
    pub screen: Vec<u8>,
    pub log: Vec<u8>,
}

/// Width of a row of `n` bytes per row.
fn row_width(n: usize) -> usize {
    8 + 2 + n * 3 + usize::from(n > 8) + 1 + n + 2
}

/// Bytes per row that fit `cols` columns.
pub fn bytes_per_row(cols: u16) -> usize {
    [16, 8, 4].into_iter().find(|&n| row_width(n) <= cols as usize).unwrap_or(4)
}

fn format_row(offset: u64, bytes: &[u8], per_row: usize, color: bool) -> String {
    let mut s = String::with_capacity(row_width(per_row) + 16);
    let (off, asc, rst) = if color { (OFFSET, ASCII, RESET) } else { ("", "", "") };
    let _ = write!(s, "{off}{offset:08X}{rst}  ");
    for i in 0..per_row {
        if i == 8 && per_row > 8 {
            s.push(' ');
        }
        match bytes.get(i) {
            Some(b) => {
                let _ = write!(s, "{b:02X} ");
            }
            None => s.push_str("   "),
        }
    }
    s.push(' ');
    s.push('|');
    s.push_str(asc);
    s.extend(bytes.iter().map(|&b| if (0x20..0x7f).contains(&b) { b as char } else { '.' }));
    s.push_str(rst);
    s.push('|');
    s
}

impl HexDump {
    pub fn feed(&mut self, data: &[u8], cols: u16) -> DumpOutput {
        let mut out = DumpOutput::default();
        if data.is_empty() {
            return out;
        }
        // Redraw the partly printed row with the new bytes.
        if !self.row.is_empty() {
            out.screen.extend_from_slice(b"\r\x1b[K");
        }
        for &b in data {
            if self.row.is_empty() {
                self.per_row = bytes_per_row(cols);
            }
            self.row.push(b);
            if self.row.len() == self.per_row {
                out.screen.extend_from_slice(format_row(self.offset, &self.row, self.per_row, true).as_bytes());
                out.screen.extend_from_slice(b"\r\n");
                out.log.extend_from_slice(format_row(self.offset, &self.row, self.per_row, false).as_bytes());
                out.log.extend_from_slice(b"\r\n");
                self.offset += self.row.len() as u64;
                self.row.clear();
            }
        }
        if !self.row.is_empty() {
            out.screen.extend_from_slice(format_row(self.offset, &self.row, self.per_row, true).as_bytes());
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(bytes: &[u8]) -> String {
        // Drop SGR colors to compare the layout.
        let s = String::from_utf8(bytes.to_vec()).unwrap();
        let mut out = String::new();
        let mut it = s.chars().peekable();
        while let Some(c) = it.next() {
            if c == '\x1b' && it.peek() == Some(&'[') {
                for d in it.by_ref() {
                    if d.is_ascii_alphabetic() {
                        break;
                    }
                }
            } else {
                out.push(c);
            }
        }
        out
    }

    #[test]
    fn full_rows() {
        let mut d = HexDump::default();
        let out = d.feed(b"Hello World\r\n\x00\x01\x02ABC", 80);
        assert_eq!(
            String::from_utf8(out.log).unwrap(),
            "00000000  48 65 6C 6C 6F 20 57 6F  72 6C 64 0D 0A 00 01 02  |Hello World.....|\r\n"
        );
        assert_eq!(
            plain(&out.screen),
            "00000000  48 65 6C 6C 6F 20 57 6F  72 6C 64 0D 0A 00 01 02  |Hello World.....|\r\n\
             00000010  41 42 43                                          |ABC|"
        );
        assert_eq!(row_width(16), 78);
    }

    #[test]
    fn partial_row_is_redrawn() {
        let mut d = HexDump::default();
        // Padded so the ASCII column lines up with full rows.
        let first = plain(&d.feed(b"\xAA", 80).screen);
        assert_eq!(first, format!("00000000  AA{}|.|", " ".repeat(48)));
        assert_eq!(first.find('|'), Some(row_width(16) - 2 - 16));
        let out = d.feed(b"\xBB", 80);
        assert!(out.screen.starts_with(b"\r\x1b[K"));
        assert!(plain(&out.screen).contains("AA BB"));
        assert!(out.log.is_empty());
        // Rest of the row, then a new row with no redraw prefix after it.
        let out = d.feed(&[0u8; 14], 80);
        assert!(plain(&out.screen).ends_with("|..|\r\n".replace("..", &".".repeat(16)).as_str()));
        assert!(!d.feed(b"Z", 80).screen.starts_with(b"\r"));
        assert_eq!(d.offset, 16);
    }

    #[test]
    fn narrow_panes() {
        assert_eq!(bytes_per_row(120), 16);
        assert_eq!(bytes_per_row(78), 16);
        assert_eq!(bytes_per_row(77), 8);
        assert_eq!(bytes_per_row(30), 4);
        let mut d = HexDump::default();
        let out = d.feed(b"0123456789", 50);
        assert_eq!(
            String::from_utf8(out.log).unwrap(),
            "00000000  30 31 32 33 34 35 36 37  |01234567|\r\n"
        );
        assert!(row_width(8) <= 50);
    }
}
