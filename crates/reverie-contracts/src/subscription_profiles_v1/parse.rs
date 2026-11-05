//! `JSON.parse` then `z.array(subscriptionProfileSchema).max(32)` then the duplicate-id refusal. Every failure
//! gets the same TS response, so parsing stops at the first one. Values that a later duplicate key replaces
//! are syntax-checked and dropped without recursion, as V8 accepts any nesting depth.
use super::{JsString, MAX_PROFILES, Platform, Profile, Provider};
use std::fmt;

/// The file is not a valid profile list. TS answers 500 OPERATION_FAILED.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidFile;
impl fmt::Display for InvalidFile {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("INVALID_FILE")
    }
}
impl std::error::Error for InvalidFile {}

type Parsed<T> = Result<T, InvalidFile>;

const KEYS: [&str; 5] = ["id", "label", "provider", "configDir", "openCodeDataDir"];
const QUOTE: u16 = b'"' as u16;

/// Node `fs.readFile(path, 'utf8')` keeps a BOM and replaces invalid sequences, then the parse above.
pub fn parse_file(raw: &[u8], platform: Platform) -> Parsed<Vec<Profile>> {
    let units: Vec<u16> = String::from_utf8_lossy(raw).encode_utf16().collect();
    let mut cursor = Cursor {
        units: &units,
        at: 0,
    };
    let profiles = cursor.profiles(platform)?;
    cursor.space();
    if cursor.at != units.len() {
        return Err(InvalidFile);
    }
    for (index, profile) in profiles.iter().enumerate() {
        if profiles[..index].iter().any(|other| other.id == profile.id) {
            return Err(InvalidFile);
        }
    }
    Ok(profiles)
}

enum Field {
    Text(Vec<u16>),
    Other,
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum Open {
    Array,
    Object,
}

struct Cursor<'a> {
    units: &'a [u16],
    at: usize,
}
impl Cursor<'_> {
    fn peek(&self) -> Option<u16> {
        self.units.get(self.at).copied()
    }
    fn advance(&mut self) -> Parsed<u16> {
        let unit = self.peek().ok_or(InvalidFile)?;
        self.at += 1;
        Ok(unit)
    }
    fn space(&mut self) {
        while matches!(self.peek(), Some(0x09 | 0x0a | 0x0d | 0x20)) {
            self.at += 1;
        }
    }
    /// Skips space, then consumes `unit` if it is next.
    fn take(&mut self, unit: u8) -> bool {
        self.space();
        let found = self.peek() == Some(u16::from(unit));
        if found {
            self.at += 1;
        }
        found
    }
    fn expect(&mut self, unit: u8) -> Parsed<()> {
        if self.take(unit) {
            Ok(())
        } else {
            Err(InvalidFile)
        }
    }

    fn profiles(&mut self, platform: Platform) -> Parsed<Vec<Profile>> {
        self.expect(b'[')?;
        let mut profiles = Vec::new();
        if self.take(b']') {
            return Ok(profiles);
        }
        loop {
            if profiles.len() == MAX_PROFILES {
                return Err(InvalidFile);
            }
            profiles.push(self.profile(platform)?);
            if !self.take(b',') {
                self.expect(b']')?;
                return Ok(profiles);
            }
        }
    }
    fn profile(&mut self, platform: Platform) -> Parsed<Profile> {
        self.expect(b'{')?;
        let mut fields: [Option<Field>; 5] = Default::default();
        if !self.take(b'}') {
            self.members(&mut fields)?;
        }
        let [id, label, provider, config_dir, open_code_data_dir] =
            fields.map(|field| match field {
                Some(Field::Text(units)) => Some(units),
                _ => None,
            });
        let profile = Profile {
            id: JsString(id.ok_or(InvalidFile)?),
            label: JsString(label.ok_or(InvalidFile)?),
            provider: Provider::parse(&provider.ok_or(InvalidFile)?).ok_or(InvalidFile)?,
            config_dir: JsString(config_dir.ok_or(InvalidFile)?),
            open_code_data_dir: JsString(open_code_data_dir.ok_or(InvalidFile)?),
        };
        profile.checked(platform).ok_or(InvalidFile)
    }
    /// Members up to and including the closing `}`.
    fn members(&mut self, fields: &mut [Option<Field>; 5]) -> Parsed<()> {
        loop {
            self.member(fields)?;
            if !self.take(b',') {
                return self.expect(b'}');
            }
        }
    }
    /// One `"key": value`. The last duplicate wins; zod's strict check skips `__proto__` and refuses others.
    fn member(&mut self, fields: &mut [Option<Field>; 5]) -> Parsed<()> {
        let key = self.key()?;
        let named = |name: &str| key.iter().copied().eq(name.encode_utf16());
        match KEYS.iter().position(|name| named(name)) {
            Some(slot) => {
                self.space();
                fields[slot] = Some(if self.peek() == Some(QUOTE) {
                    Field::Text(self.string()?)
                } else {
                    self.skip_value()?;
                    Field::Other
                });
                Ok(())
            }
            None if named("__proto__") => self.skip_value(),
            None => Err(InvalidFile),
        }
    }

    fn string(&mut self) -> Parsed<Vec<u16>> {
        if self.advance()? != QUOTE {
            return Err(InvalidFile);
        }
        let mut text = Vec::new();
        loop {
            match self.advance()? {
                QUOTE => return Ok(text),
                0x5c => text.push(self.escape()?),
                unit if unit < 0x20 => return Err(InvalidFile),
                unit => text.push(unit),
            }
        }
    }
    fn escape(&mut self) -> Parsed<u16> {
        let unit = u8::try_from(self.advance()?).map_err(|_| InvalidFile)?;
        Ok(match unit {
            b'"' | b'\\' | b'/' => u16::from(unit),
            b'b' => 0x08,
            b'f' => 0x0c,
            b'n' => 0x0a,
            b'r' => 0x0d,
            b't' => 0x09,
            b'u' => {
                let mut code = 0u16;
                for _ in 0..4 {
                    let digit =
                        char::from_u32(u32::from(self.advance()?)).and_then(|c| c.to_digit(16));
                    code = code * 16
                        + u16::try_from(digit.ok_or(InvalidFile)?).map_err(|_| InvalidFile)?;
                }
                code
            }
            _ => return Err(InvalidFile),
        })
    }

    /// Any JSON value, with an explicit stack instead of recursion.
    fn skip_value(&mut self) -> Parsed<()> {
        let mut open = Vec::new();
        loop {
            self.space();
            match self.skip_scalar_or_open()? {
                Some(container) => open.push(container),
                None if self.close(&mut open)? => {}
                None => return Ok(()),
            }
        }
    }
    /// After a complete value, closes finished containers. True when another value follows.
    fn close(&mut self, open: &mut Vec<Open>) -> Parsed<bool> {
        while let Some(&container) = open.last() {
            if self.take(b',') {
                self.open_member(container)?;
                return Ok(true);
            }
            self.expect(if container == Open::Array { b']' } else { b'}' })?;
            open.pop();
        }
        Ok(false)
    }
    /// After `[`, `{` or a separating `,`: an object member starts with its key.
    fn open_member(&mut self, container: Open) -> Parsed<()> {
        if container == Open::Object {
            self.key()?;
        }
        Ok(())
    }
    fn key(&mut self) -> Parsed<Vec<u16>> {
        self.space();
        let key = self.string()?;
        self.expect(b':')?;
        Ok(key)
    }
    /// Consumes a scalar or an empty container, or opens a container whose first value comes next.
    fn skip_scalar_or_open(&mut self) -> Parsed<Option<Open>> {
        let unit = u8::try_from(self.peek().ok_or(InvalidFile)?).map_err(|_| InvalidFile)?;
        match unit {
            b'"' => self.string().map(|_| None),
            b'[' | b'{' => {
                self.at += 1;
                let (container, close) = if unit == b'[' {
                    (Open::Array, b']')
                } else {
                    (Open::Object, b'}')
                };
                if self.take(close) {
                    return Ok(None);
                }
                self.open_member(container)?;
                Ok(Some(container))
            }
            b't' => self.word("true").map(|()| None),
            b'f' => self.word("false").map(|()| None),
            b'n' => self.word("null").map(|()| None),
            b'-' | b'0'..=b'9' => self.number().map(|()| None),
            _ => Err(InvalidFile),
        }
    }
    fn word(&mut self, word: &str) -> Parsed<()> {
        for expected in word.encode_utf16() {
            if self.advance()? != expected {
                return Err(InvalidFile);
            }
        }
        Ok(())
    }
    /// `-? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?`; the value itself is never needed.
    fn number(&mut self) -> Parsed<()> {
        let is = |cursor: &Self, wanted: &[u8]| {
            cursor
                .peek()
                .is_some_and(|unit| u8::try_from(unit).is_ok_and(|byte| wanted.contains(&byte)))
        };
        let digits = |cursor: &mut Self| {
            let start = cursor.at;
            while is(cursor, b"0123456789") {
                cursor.at += 1;
            }
            if cursor.at == start {
                Err(InvalidFile)
            } else {
                Ok(())
            }
        };
        if is(self, b"-") {
            self.at += 1;
        }
        if is(self, b"0") {
            self.at += 1;
        } else {
            digits(self)?;
        }
        if is(self, b".") {
            self.at += 1;
            digits(self)?;
        }
        if is(self, b"eE") {
            self.at += 1;
            if is(self, b"+-") {
                self.at += 1;
            }
            digits(self)?;
        }
        Ok(())
    }
}
