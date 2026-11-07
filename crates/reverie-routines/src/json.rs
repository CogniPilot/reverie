//! JSON as python's `json` module reads and writes it: object keys keep their order (a repeated key keeps its first
//! position and its last value), integers and floats stay distinct, `NaN` and `Infinity` are accepted, and a syntax
//! error is worded as python words it, with python's line, column and character position.

use std::fmt::Write as _;

/// A decoded JSON value.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    /// An integer literal. Python's integers are unbounded; one beyond `i128` keeps only its float approximation.
    Int(i128),
    BigInt(f64),
    Float(f64),
    Str(String),
    List(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(items) => items.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    /// Python's `isinstance(v, (int, float)) and not isinstance(v, bool)`, as a float.
    pub fn number(&self) -> Option<f64> {
        match self {
            // Exact below 2**53, which every timestamp and percentage is; python's int/float true division agrees.
            #[allow(clippy::cast_precision_loss)]
            Json::Int(i) => Some(*i as f64),
            Json::BigInt(f) | Json::Float(f) => Some(*f),
            _ => None,
        }
    }

    /// Python truthiness.
    pub fn truthy(&self) -> bool {
        match self {
            Json::Null => false,
            Json::Bool(b) => *b,
            Json::Int(i) => *i != 0,
            Json::BigInt(_) => true,
            Json::Float(f) => *f != 0.0,
            Json::Str(s) => !s.is_empty(),
            Json::List(l) => !l.is_empty(),
            Json::Obj(o) => !o.is_empty(),
        }
    }
}

/// A syntax error, worded and positioned as python's `json.JSONDecodeError`.
#[derive(Debug)]
pub struct DecodeError(pub String);

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Deeper nesting than this is refused; python raised RecursionError somewhere near 1000 levels.
const MAX_DEPTH: usize = 512;

struct Parser {
    chars: Vec<char>,
}

enum Fail {
    /// A positioned decode error.
    At(&'static str, usize),
    /// `scan_once` found no value at this position ("Expecting value").
    NoValue(usize),
    Deep,
}

impl Parser {
    fn ws(&self, mut at: usize) -> usize {
        while at < self.chars.len() && matches!(self.chars[at], ' ' | '\t' | '\n' | '\r') {
            at += 1;
        }
        at
    }

    fn starts(&self, at: usize, word: &str) -> bool {
        (at..)
            .zip(word.chars())
            .all(|(i, c)| self.chars.get(i) == Some(&c))
    }

    /// The end of a run of ASCII digits starting at `at`.
    fn digits(&self, mut at: usize) -> usize {
        while self.chars.get(at).is_some_and(char::is_ascii_digit) {
            at += 1;
        }
        at
    }

    fn value(&self, at: usize, depth: usize) -> Result<(Json, usize), Fail> {
        if depth > MAX_DEPTH {
            return Err(Fail::Deep);
        }
        let Some(&c) = self.chars.get(at) else {
            return Err(Fail::NoValue(at));
        };
        match c {
            '"' => self.string(at + 1).map(|(s, end)| (Json::Str(s), end)),
            '{' => self.object(at + 1, depth),
            '[' => self.array(at + 1, depth),
            'n' if self.starts(at, "null") => Ok((Json::Null, at + 4)),
            't' if self.starts(at, "true") => Ok((Json::Bool(true), at + 4)),
            'f' if self.starts(at, "false") => Ok((Json::Bool(false), at + 5)),
            'N' if self.starts(at, "NaN") => Ok((Json::Float(f64::NAN), at + 3)),
            'I' if self.starts(at, "Infinity") => Ok((Json::Float(f64::INFINITY), at + 8)),
            '-' if self.starts(at, "-Infinity") => Ok((Json::Float(f64::NEG_INFINITY), at + 9)),
            _ => self.number(at).ok_or(Fail::NoValue(at)),
        }
    }

    /// `(-?(?:0|[1-9]\d*))(\.\d+)?([eE][-+]?\d+)?`, matched at `at`.
    fn number(&self, at: usize) -> Option<(Json, usize)> {
        let digit = |i: usize| self.chars.get(i).is_some_and(char::is_ascii_digit);
        let mut i = at + usize::from(self.chars.get(at) == Some(&'-'));
        i = match self.chars.get(i) {
            Some('0') => i + 1,
            Some('1'..='9') => self.digits(i),
            _ => return None,
        };
        let int_end = i;
        if self.chars.get(i) == Some(&'.') && digit(i + 1) {
            i = self.digits(i + 1);
        }
        if matches!(self.chars.get(i), Some('e' | 'E')) {
            let j = i + 1 + usize::from(matches!(self.chars.get(i + 1), Some('+' | '-')));
            if digit(j) {
                i = self.digits(j);
            }
        }
        let text: String = self.chars[at..i].iter().collect();
        if i == int_end {
            return Some((
                text.parse::<i128>().map_or_else(
                    |_| Json::BigInt(text.parse().unwrap_or(f64::INFINITY)),
                    Json::Int,
                ),
                i,
            ));
        }
        Some((Json::Float(text.parse().unwrap_or(f64::NAN)), i))
    }

    fn hex4(&self, at: usize) -> Option<u32> {
        let mut value = 0;
        for i in at..at + 4 {
            value = value * 16 + self.chars.get(i)?.to_digit(16)?;
        }
        Some(value)
    }

    /// One escape whose backslash is at `at`: the character and the position after it.
    fn escape(&self, at: usize, begin: usize) -> Result<(char, usize), Fail> {
        let Some(&e) = self.chars.get(at + 1) else {
            return Err(Fail::At("Unterminated string starting at", begin - 1));
        };
        let simple = match e {
            '"' => '"',
            '\\' => '\\',
            '/' => '/',
            'b' => '\u{8}',
            'f' => '\u{c}',
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            'u' => return self.unicode_escape(at),
            _ => return Err(Fail::At("Invalid \\escape", at)),
        };
        Ok((simple, at + 2))
    }

    /// `\uXXXX`, joined with a following low-surrogate escape when it is a high surrogate.
    fn unicode_escape(&self, at: usize) -> Result<(char, usize), Fail> {
        let unit = self
            .hex4(at + 2)
            .ok_or(Fail::At("Invalid \\uXXXX escape", at + 1))?;
        let next = at + 6;
        let low = (self.chars.get(next) == Some(&'\\') && self.chars.get(next + 1) == Some(&'u'))
            .then(|| self.hex4(next + 2))
            .flatten()
            .filter(|low| (0xd800..0xdc00).contains(&unit) && (0xdc00..0xe000).contains(low));
        let (code, end) = match low {
            Some(low) => (0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00), next + 6),
            None => (unit, next),
        };
        // A lone surrogate, which python keeps, has no Rust char: it reads as U+FFFD.
        Ok((char::from_u32(code).unwrap_or('\u{fffd}'), end))
    }

    /// A string whose opening quote is at `begin - 1`.
    fn string(&self, begin: usize) -> Result<(String, usize), Fail> {
        let mut out = String::new();
        let mut at = begin;
        loop {
            let Some(&c) = self.chars.get(at) else {
                return Err(Fail::At("Unterminated string starting at", begin - 1));
            };
            match c {
                '"' => return Ok((out, at + 1)),
                '\\' => {
                    let (ch, end) = self.escape(at, begin)?;
                    out.push(ch);
                    at = end;
                }
                c if (c as u32) < 0x20 => return Err(Fail::At("Invalid control character at", at)),
                c => {
                    out.push(c);
                    at += 1;
                }
            }
        }
    }

    fn object(&self, start: usize, depth: usize) -> Result<(Json, usize), Fail> {
        let mut items: Vec<(String, Json)> = Vec::new();
        let mut at = self.ws(start);
        if self.chars.get(at) == Some(&'}') {
            return Ok((Json::Obj(items), at + 1));
        }
        loop {
            if self.chars.get(at) != Some(&'"') {
                return Err(Fail::At(
                    "Expecting property name enclosed in double quotes",
                    at,
                ));
            }
            let (key, end) = self.string(at + 1)?;
            at = self.ws(end);
            if self.chars.get(at) != Some(&':') {
                return Err(Fail::At("Expecting ':' delimiter", at));
            }
            at = self.ws(at + 1);
            let (value, end) = self.value(at, depth + 1).map_err(|f| match f {
                Fail::NoValue(p) => Fail::At("Expecting value", p),
                other => other,
            })?;
            match items.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => slot.1 = value,
                None => items.push((key, value)),
            }
            at = self.ws(end);
            match self.chars.get(at) {
                Some('}') => return Ok((Json::Obj(items), at + 1)),
                Some(',') => {}
                _ => return Err(Fail::At("Expecting ',' delimiter", at)),
            }
            let comma = at;
            at = self.ws(at + 1);
            if self.chars.get(at) == Some(&'}') {
                return Err(Fail::At(
                    "Illegal trailing comma before end of object",
                    comma,
                ));
            }
        }
    }

    fn array(&self, start: usize, depth: usize) -> Result<(Json, usize), Fail> {
        let mut items = Vec::new();
        let mut at = self.ws(start);
        if self.chars.get(at) == Some(&']') {
            return Ok((Json::List(items), at + 1));
        }
        loop {
            let (value, end) = self.value(at, depth + 1).map_err(|f| match f {
                Fail::NoValue(p) => Fail::At("Expecting value", p),
                other => other,
            })?;
            items.push(value);
            at = self.ws(end);
            match self.chars.get(at) {
                Some(']') => return Ok((Json::List(items), at + 1)),
                Some(',') => {}
                _ => return Err(Fail::At("Expecting ',' delimiter", at)),
            }
            let comma = at;
            at = self.ws(at + 1);
            if self.chars.get(at) == Some(&']') {
                return Err(Fail::At(
                    "Illegal trailing comma before end of array",
                    comma,
                ));
            }
        }
    }

    fn error(&self, message: &str, pos: usize) -> DecodeError {
        let before = &self.chars[..pos.min(self.chars.len())];
        let line = before.iter().filter(|c| **c == '\n').count() + 1;
        let column = before
            .iter()
            .rposition(|c| *c == '\n')
            .map_or(pos + 1, |nl| pos - nl);
        DecodeError(format!(
            "{message}: line {line} column {column} (char {pos})"
        ))
    }
}

/// `json.loads(text)`.
pub fn parse(text: &str) -> Result<Json, DecodeError> {
    let parser = Parser {
        chars: text.chars().collect(),
    };
    if parser.chars.first() == Some(&'\u{feff}') {
        return Err(parser.error("Unexpected UTF-8 BOM (decode using utf-8-sig)", 0));
    }
    let start = parser.ws(0);
    let (value, end) = parser.value(start, 0).map_err(|f| match f {
        Fail::At(m, p) => parser.error(m, p),
        Fail::NoValue(p) => parser.error("Expecting value", p),
        Fail::Deep => {
            DecodeError("maximum recursion depth exceeded while decoding a JSON document".into())
        }
    })?;
    let end = parser.ws(end);
    if end != parser.chars.len() {
        return Err(parser.error("Extra data", end));
    }
    Ok(value)
}

/// Python's `repr(float)` (and so `str` and `json.dumps`) for the values the tick stores: shortest round-trip
/// digits, fixed notation from 1e-4 up to 1e16, exponent notation outside it.
pub fn py_float(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    if x == 0.0 {
        return if x.is_sign_negative() {
            "-0.0".into()
        } else {
            "0.0".into()
        };
    }
    let exp = format!("{x:e}");
    let (mantissa, e) = exp.split_once('e').unwrap_or((&exp, "0"));
    let e: i32 = e.parse().unwrap_or(0);
    if (-4..16).contains(&e) {
        let fixed = format!("{x}");
        return if fixed.contains('.') {
            fixed
        } else {
            format!("{fixed}.0")
        };
    }
    format!("{mantissa}e{}{:02}", if e < 0 { '-' } else { '+' }, e.abs())
}

fn dump_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            ' '..='~' => out.push(c),
            c => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    let _ = write!(out, "\\u{unit:04x}");
                }
            }
        }
    }
    out.push('"');
}

/// `json.dumps(value)` with python's defaults: `", "` and `": "` separators and `ensure_ascii`.
pub fn dump(value: &Json) -> String {
    let mut out = String::new();
    dump_into(&mut out, value);
    out
}

fn dump_into(out: &mut String, value: &Json) {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Int(i) => {
            let _ = write!(out, "{i}");
        }
        Json::BigInt(f) | Json::Float(f) => out.push_str(&py_float(*f)),
        Json::Str(s) => dump_str(out, s),
        Json::List(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                dump_into(out, item);
            }
            out.push(']');
        }
        Json::Obj(items) => {
            out.push('{');
            for (i, (key, item)) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                dump_str(out, key);
                out.push_str(": ");
                dump_into(out, item);
            }
            out.push('}');
        }
    }
}

/// Python's `repr(str)`: single quotes unless the text has one and no double quote.
pub fn py_repr(s: &str) -> String {
    let quote = if s.contains('\'') && !s.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = String::new();
    out.push(quote);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || (0x7f..0xa1).contains(&(c as u32)) => {
                let _ = write!(out, "\\x{:02x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}
