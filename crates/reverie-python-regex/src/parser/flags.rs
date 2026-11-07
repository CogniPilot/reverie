use super::*;
pub(super) fn flag(token: Token) -> Option<u32> {
    match token {
        Token::Char(105) => Some(IGNORE),
        Token::Char(76) => Some(LOCALE),
        Token::Char(109) => Some(MULTILINE),
        Token::Char(115) => Some(DOTALL),
        Token::Char(120) => Some(VERBOSE),
        Token::Char(97) => Some(ASCII),
        Token::Char(117) => Some(UNICODE),
        _ => None,
    }
}
fn alpha(token: Token) -> bool {
    matches!(token,Token::Char(point)if facts::alpha(point))
}
impl Parser {
    fn flag_error(&self, token: Token, missing: &str) -> RegexError {
        self.cursor.error(
            if alpha(token) {
                "unknown flag"
            } else {
                missing
            },
            token.len(),
        )
    }

    pub(super) fn flags(&mut self, token: Token) -> Result<Option<(u32, u32)>> {
        let (add, token) = if token.is(b'-') {
            (0, token)
        } else {
            self.add_flags(token)?
        };
        if token.is(b')') {
            self.parsed.flags |= add;
            return Ok(None);
        }
        let remove = if token.is(b'-') {
            self.remove_flags()?
        } else {
            debug_assert!(token.is(b':'));
            0
        };
        if add & remove != 0 {
            return Err(self
                .cursor
                .error("bad inline flags: flag turned on and off", 1));
        }
        Ok(Some((add, remove)))
    }
    fn add_flags(&mut self, mut token: Token) -> Result<(u32, Token)> {
        let mut add = 0;
        loop {
            let value = flag(token).expect("initial or validated flag");
            if token.is(b'L') {
                return Err(self.cursor.error(
                    "bad inline flags: cannot use 'L' flag with a str pattern",
                    0,
                ));
            }
            add |= value;
            if value & TYPE_FLAGS != 0 && add & TYPE_FLAGS != value {
                return Err(self.cursor.error(
                    "bad inline flags: flags 'a', 'u' and 'L' are incompatible",
                    0,
                ));
            }
            token = self
                .cursor
                .take()?
                .ok_or_else(|| self.cursor.error("missing -, : or )", 0))?;
            if token.is(b')') || token.is(b'-') || token.is(b':') {
                return Ok((add, token));
            }
            if flag(token).is_none() {
                return Err(self.flag_error(token, "missing -, : or )"));
            }
        }
    }
    fn remove_flags(&mut self) -> Result<u32> {
        let mut token = self
            .cursor
            .take()?
            .ok_or_else(|| self.cursor.error("missing flag", 0))?;
        if flag(token).is_none() {
            return Err(self.flag_error(token, "missing flag"));
        }
        let mut remove = 0;
        loop {
            let value = flag(token).expect("validated remove flag");
            if value & TYPE_FLAGS != 0 {
                return Err(self.cursor.error(
                    "bad inline flags: cannot turn off flags 'a', 'u' and 'L'",
                    0,
                ));
            }
            remove |= value;
            token = self
                .cursor
                .take()?
                .ok_or_else(|| self.cursor.error("missing :", 0))?;
            if token.is(b':') {
                return Ok(remove);
            }
            if flag(token).is_none() {
                return Err(self.flag_error(token, "missing :"));
            }
        }
    }
}
