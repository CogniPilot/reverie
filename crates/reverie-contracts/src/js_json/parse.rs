//! ECMAScript `JSON.parse` (ECMA-404 grammar) without recursion. Containers deeper than the caller's
//! bound are still checked for syntax, but only their kind is kept, so a deep file can neither
//! overflow the stack nor build a value that would.
use super::{Object, Value};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ParseError {
    /// Not JSON; `JSON.parse` would throw.
    Syntax,
    /// Valid JSON nested deeper than the bound.
    Depth,
}

/// One open container. Levels past the bound keep no contents.
enum Level {
    Array(Vec<Value>),
    /// The object so far and the key awaiting its value.
    Object(Object, Vec<u16>),
    Deep {
        object: bool,
    },
}

struct Scanner<'a> {
    text: &'a str,
    position: usize,
}

struct Parser<'a> {
    scanner: Scanner<'a>,
    levels: Vec<Level>,
    max_depth: usize,
    too_deep: bool,
}

/// What attaching a value to its container left the parser expecting.
enum Attached {
    /// A separator was read; the next value of the same container follows.
    Next,
    /// The container ended.
    Closed,
}

/// Parses `text` as `JSON.parse` does, refusing nesting deeper than `max_depth` containers.
pub fn parse(text: &str, max_depth: usize) -> Result<Value, ParseError> {
    let mut parser = Parser {
        scanner: Scanner { text, position: 0 },
        levels: Vec::new(),
        max_depth,
        too_deep: false,
    };
    loop {
        let Some(value) = parser.value()? else {
            continue;
        };
        if let Some(top) = parser.close(value)? {
            return parser.finish(top);
        }
    }
}

impl Parser<'_> {
    /// The next value, or `None` after opening a non-empty container.
    fn value(&mut self) -> Result<Option<Value>, ParseError> {
        self.scanner.whitespace();
        match self.scanner.peek().ok_or(ParseError::Syntax)? {
            b'[' => self.open(false),
            b'{' => self.open(true),
            _ => self.scanner.scalar().map(Some),
        }
    }

    fn open(&mut self, object: bool) -> Result<Option<Value>, ParseError> {
        let deep = self.levels.len() >= self.max_depth;
        self.too_deep |= deep;
        self.scanner.position += 1;
        self.scanner.whitespace();
        if self.scanner.eat(if object { b'}' } else { b']' }) {
            return Ok(Some(if object {
                Value::Object(Object::default())
            } else {
                Value::Array(Vec::new())
            }));
        }
        let level = match (deep, object) {
            (true, _) => {
                if object {
                    self.scanner.key()?;
                }
                Level::Deep { object }
            }
            (false, true) => Level::Object(Object::default(), self.scanner.key()?),
            (false, false) => Level::Array(Vec::new()),
        };
        self.levels.push(level);
        Ok(None)
    }

    /// Attaches `value` and closes every container that ends here: `Some` is the finished
    /// top-level value, `None` means another value follows.
    fn close(&mut self, mut value: Value) -> Result<Option<Value>, ParseError> {
        loop {
            self.scanner.whitespace();
            let Some(level) = self.levels.last_mut() else {
                return Ok(Some(value));
            };
            match attach(&mut self.scanner, level, value)? {
                Attached::Next => return Ok(None),
                Attached::Closed => value = self.pop(),
            }
        }
    }

    fn pop(&mut self) -> Value {
        match self.levels.pop() {
            Some(Level::Array(items)) => Value::Array(items),
            Some(Level::Object(object, _)) => Value::Object(object),
            Some(Level::Deep { .. }) | None => Value::Null,
        }
    }

    fn finish(&self, top: Value) -> Result<Value, ParseError> {
        if self.scanner.position != self.scanner.text.len() {
            Err(ParseError::Syntax)
        } else if self.too_deep {
            Err(ParseError::Depth)
        } else {
            Ok(top)
        }
    }
}

fn attach(
    scanner: &mut Scanner<'_>,
    level: &mut Level,
    value: Value,
) -> Result<Attached, ParseError> {
    let (object, close) = match level {
        Level::Array(items) => {
            items.push(value);
            (false, b']')
        }
        Level::Object(object, key) => {
            object.insert(std::mem::take(key), value);
            (true, b'}')
        }
        Level::Deep { object } => (*object, if *object { b'}' } else { b']' }),
    };
    if !scanner.eat(b',') {
        scanner.expect(close)?;
        return Ok(Attached::Closed);
    }
    if object {
        scanner.whitespace();
        let key = scanner.key()?;
        if let Level::Object(_, pending) = level {
            *pending = key;
        }
    }
    Ok(Attached::Next)
}

impl Scanner<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.position).copied()
    }

    fn eat(&mut self, byte: u8) -> bool {
        let matched = self.peek() == Some(byte);
        if matched {
            self.position += 1;
        }
        matched
    }

    fn expect(&mut self, byte: u8) -> Result<(), ParseError> {
        if self.eat(byte) {
            Ok(())
        } else {
            Err(ParseError::Syntax)
        }
    }

    /// JSON whitespace is exactly space, tab, line feed and carriage return.
    fn whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.position += 1;
        }
    }

    /// A member name and its colon.
    fn key(&mut self) -> Result<Vec<u16>, ParseError> {
        if self.peek() != Some(b'"') {
            return Err(ParseError::Syntax);
        }
        let key = self.string()?;
        self.whitespace();
        self.expect(b':')?;
        Ok(key)
    }

    fn scalar(&mut self) -> Result<Value, ParseError> {
        match self.peek() {
            Some(b'"') => self.string().map(Value::String),
            Some(b't') => self.literal("true", Value::Bool(true)),
            Some(b'f') => self.literal("false", Value::Bool(false)),
            Some(b'n') => self.literal("null", Value::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(ParseError::Syntax),
        }
    }

    fn literal(&mut self, word: &str, value: Value) -> Result<Value, ParseError> {
        if self.text[self.position..].starts_with(word) {
            self.position += word.len();
            Ok(value)
        } else {
            Err(ParseError::Syntax)
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.position;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.position += 1;
        }
        self.position - start
    }

    /// The nearest double to the literal; overflow is infinity and underflow a signed zero, as
    /// `JSON.parse` gives them.
    fn number(&mut self) -> Result<Value, ParseError> {
        let start = self.position;
        self.eat(b'-');
        match self.peek() {
            Some(b'0') => self.position += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return Err(ParseError::Syntax),
        }
        if self.eat(b'.') && self.digits() == 0 {
            return Err(ParseError::Syntax);
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.position += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.position += 1;
            }
            if self.digits() == 0 {
                return Err(ParseError::Syntax);
            }
        }
        // The grammar above is a subset of what `f64::from_str` accepts, which rounds correctly.
        self.text[start..self.position]
            .parse::<f64>()
            .map(Value::Number)
            .map_err(|_| ParseError::Syntax)
    }

    /// The code unit an escape after `\\` names; `\u` may name a lone surrogate.
    fn escape(&mut self) -> Result<u16, ParseError> {
        let escape = self.peek().ok_or(ParseError::Syntax)?;
        self.position += 1;
        Ok(match escape {
            b'"' => 0x22,
            b'\\' => 0x5c,
            b'/' => 0x2f,
            b'b' => 0x08,
            b'f' => 0x0c,
            b'n' => 0x0a,
            b'r' => 0x0d,
            b't' => 0x09,
            b'u' => {
                let hex = self
                    .text
                    .get(self.position..self.position + 4)
                    .filter(|hex| hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
                    .ok_or(ParseError::Syntax)?;
                self.position += 4;
                u16::from_str_radix(hex, 16).map_err(|_| ParseError::Syntax)?
            }
            _ => return Err(ParseError::Syntax),
        })
    }

    /// A string's code units; `\u` escapes may name lone surrogates.
    fn string(&mut self) -> Result<Vec<u16>, ParseError> {
        self.position += 1;
        let mut units = Vec::new();
        loop {
            let byte = self.peek().ok_or(ParseError::Syntax)?;
            match byte {
                b'"' => {
                    self.position += 1;
                    return Ok(units);
                }
                b'\\' => {
                    self.position += 1;
                    units.push(self.escape()?);
                }
                0x00..=0x1f => return Err(ParseError::Syntax),
                _ => {
                    let character = self.text[self.position..]
                        .chars()
                        .next()
                        .ok_or(ParseError::Syntax)?;
                    self.position += character.len_utf8();
                    let mut buffer = [0; 2];
                    units.extend_from_slice(character.encode_utf16(&mut buffer));
                }
            }
        }
    }
}
