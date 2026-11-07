//! Bounded streaming equivalent of the terminal's UTF-8 read_text then int(str).
//! All bytes still need scanning: later decode/read faults precede conversion.
use crate::legacy_json::DEFAULT_INT_MAX_DIGITS;
#[derive(Default)]
enum Syntax {
    #[default]
    Leading,
    Sign,
    Digits,
    Underscore,
    Trailing,
    Invalid,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExitReceiptError {
    Utf8,
    Integer,
    Digits,
}
impl std::fmt::Display for ExitReceiptError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(match self {
            Self::Utf8 => "Invalid UTF-8 completion receipt",
            Self::Integer => "Invalid integer completion receipt",
            Self::Digits => "Completion receipt exceeds Python integer conversion limit",
        })
    }
}
impl std::error::Error for ExitReceiptError {}
/// No path or completion authority is carried here. At most 4300 decimal
/// digits and one UTF-8 codepoint are kept, independent of whitespace length.
#[derive(Default)]
pub struct ExitReceiptDecoder {
    syntax: Syntax,
    negative: bool,
    digits: String,
    count: usize,
    utf8: [u8; 4],
    used: usize,
    width: usize,
    invalid_utf8: bool,
}
impl ExitReceiptDecoder {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn push(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.byte(byte);
        }
    }
    fn byte(&mut self, byte: u8) {
        if self.invalid_utf8 {
            return;
        }
        if self.used == 0 {
            if byte < 128 {
                self.point(char::from(byte));
                return;
            }
            self.width = match byte {
                0xc2..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf4 => 4,
                _ => {
                    self.invalid_utf8 = true;
                    return;
                }
            };
            self.utf8[0] = byte;
            self.used = 1;
            return;
        }
        self.utf8[self.used] = byte;
        self.used += 1;
        if self.used == self.width {
            let point = std::str::from_utf8(&self.utf8[..self.used])
                .map(|value| value.chars().next().expect("one nonempty codepoint"));
            self.used = 0;
            match point {
                Ok(point) => self.point(point),
                Err(_) => self.invalid_utf8 = true,
            }
        }
    }
    fn point(&mut self, point: char) {
        let point = classify(point);
        match (&self.syntax, point) {
            (Syntax::Leading, Point::Space) | (Syntax::Trailing, Point::Space) => {}
            (Syntax::Leading, Point::Sign(negative)) => {
                self.negative = negative;
                self.syntax = Syntax::Sign;
            }
            (
                Syntax::Leading | Syntax::Sign | Syntax::Digits | Syntax::Underscore,
                Point::Digit(digit),
            ) => {
                self.count = (self.count + 1).min(DEFAULT_INT_MAX_DIGITS + 1);
                if self.count <= DEFAULT_INT_MAX_DIGITS {
                    self.digits.push(char::from(b'0' + digit));
                }
                self.syntax = Syntax::Digits;
            }
            (Syntax::Digits, Point::Underscore) => self.syntax = Syntax::Underscore,
            (Syntax::Digits, Point::Space) => self.syntax = Syntax::Trailing,
            _ => self.syntax = Syntax::Invalid,
        }
    }
    /// Invoke only after the actual file read succeeded through EOF. A read
    /// error must win even over a decode/conversion error recorded here.
    pub fn finish(self) -> Result<Vec<u8>, ExitReceiptError> {
        if self.invalid_utf8 || self.used != 0 {
            return Err(ExitReceiptError::Utf8);
        }
        if !matches!(self.syntax, Syntax::Digits | Syntax::Trailing) {
            return Err(ExitReceiptError::Integer);
        }
        if self.count > DEFAULT_INT_MAX_DIGITS {
            return Err(ExitReceiptError::Digits);
        }
        let digits = self.digits.trim_start_matches('0');
        if digits.is_empty() {
            return Ok(b"0".to_vec());
        }
        let mut result = Vec::with_capacity(digits.len() + 1);
        if self.negative {
            result.push(b'-');
        }
        result.extend_from_slice(digits.as_bytes());
        Ok(result)
    }
}
enum Point {
    Space,
    Sign(bool),
    Digit(u8),
    Underscore,
    Other,
}
fn classify(point: char) -> Point {
    match point {
        ' ' | '\t'..='\r' => Point::Space,
        '+' => Point::Sign(false),
        '-' => Point::Sign(true),
        '_' => Point::Underscore,
        '0'..='9' => Point::Digit(point as u8 - b'0'),
        point if !point.is_ascii() => {
            let mut bytes = [0; 4];
            let text = point.encode_utf8(&mut bytes);
            match reverie_core::python_numeric_text(text).as_deref() {
                Some(" ") => Point::Space,
                Some(value) if value.len() == 1 && value.as_bytes()[0].is_ascii_digit() => {
                    Point::Digit(value.as_bytes()[0] - b'0')
                }
                _ => Point::Other,
            }
        }
        _ => Point::Other,
    }
}
