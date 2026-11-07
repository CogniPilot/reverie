use crate::error::{RegexError, Result};
use std::sync::Arc;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Token {
    Char(u32),
    Escape(u32),
}
impl Token {
    pub(crate) fn len(self) -> usize {
        if matches!(self, Self::Escape(_)) {
            2
        } else {
            1
        }
    }
    pub(crate) fn is(self, point: u8) -> bool {
        self == Self::Char(u32::from(point))
    }
    pub(crate) fn points(self) -> Vec<u32> {
        match self {
            Self::Char(cp) => vec![cp],
            Self::Escape(cp) => vec![92, cp],
        }
    }
}
pub(crate) struct Cursor {
    pub(crate) source: Arc<[u32]>,
    pub(crate) next: Option<Token>,
    index: usize,
}
impl Cursor {
    pub(crate) fn new(source: Arc<[u32]>) -> Result<Self> {
        let mut cursor = Self {
            source,
            next: None,
            index: 0,
        };
        cursor.advance()?;
        Ok(cursor)
    }
    fn advance(&mut self) -> Result<()> {
        let Some(&point) = self.source.get(self.index) else {
            self.next = None;
            return Ok(());
        };
        if point == 92 {
            let Some(&escaped) = self.source.get(self.index + 1) else {
                return Err(RegexError::new(
                    &self.source,
                    "bad escape (end of pattern)",
                    Some(self.source.len() - 1),
                ));
            };
            self.next = Some(Token::Escape(escaped));
            self.index += 2;
        } else {
            self.next = Some(Token::Char(point));
            self.index += 1;
        }
        Ok(())
    }
    pub(crate) fn position(&self) -> usize {
        self.index - self.next.map_or(0, Token::len)
    }
    pub(crate) fn take(&mut self) -> Result<Option<Token>> {
        let old = self.next;
        self.advance()?;
        Ok(old)
    }
    pub(crate) fn eat(&mut self, point: u8) -> Result<bool> {
        if self.next.is_some_and(|token| token.is(point)) {
            self.take()?;
            Ok(true)
        } else {
            Ok(false)
        }
    }
    pub(crate) fn seek(&mut self, index: usize) -> Result<()> {
        self.index = index;
        self.advance()
    }
    pub(crate) fn error(&self, message: &str, offset: usize) -> RegexError {
        RegexError::new(
            &self.source,
            message,
            Some(self.position().saturating_sub(offset)),
        )
    }
    pub(crate) fn error_points(&self, message: Vec<u32>, offset: usize) -> RegexError {
        let mut error = self.error("", offset);
        error.message = message;
        error
    }
    pub(crate) fn until(&mut self, terminator: u8, name: &str) -> Result<Vec<u32>> {
        let mut result = Vec::new();
        loop {
            let token = self.take()?;
            match token {
                None if result.is_empty() => return Err(self.error(&format!("missing {name}"), 0)),
                None => {
                    return Err(self.error(
                        &format!("missing {}, unterminated name", char::from(terminator)),
                        result.len(),
                    ));
                }
                Some(token) if token.is(terminator) && result.is_empty() => {
                    return Err(self.error(&format!("missing {name}"), 1));
                }
                Some(token) if token.is(terminator) => return Ok(result),
                Some(token) => result.extend(token.points()),
            }
        }
    }
    pub(crate) fn while_chars(
        &mut self,
        maximum: usize,
        valid: impl Fn(u32) -> bool,
    ) -> Result<Vec<u32>> {
        let mut result = Vec::new();
        for _ in 0..maximum {
            let Some(Token::Char(point)) = self.next else {
                break;
            };
            if !valid(point) {
                break;
            };
            result.push(point);
            self.take()?;
        }
        Ok(result)
    }
}
