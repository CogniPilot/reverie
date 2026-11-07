//! Case-sensitive Python fnmatch patterns over checked, lossless codepoints.
//! This is pattern DATA only; a match supplies no repository approval itself.
mod class;
use crate::PythonTextRef;
use class::Class;

enum Token {
    Star,
    Any,
    Literal(u32),
    Class(Class),
}
impl Token {
    fn accepts(&self, point: u32) -> bool {
        match self {
            Self::Star | Self::Any => true,
            Self::Literal(expected) => point == *expected,
            Self::Class(class) => class.accepts(point),
        }
    }
}
/// Compiled fnmatchcase grammar. Slash and initial dots are ordinary characters;
/// backslash is literal, and malformed/unclosed brackets remain literal text.
pub struct PythonGlob(Vec<Token>);
impl PythonGlob {
    pub fn compile(pattern: PythonTextRef<'_>) -> Self {
        let points = pattern.codepoints();
        let mut tokens = Vec::new();
        let mut at = 0;
        while at < points.len() {
            let token = next_token(&points, &mut at);
            if matches!(token, Token::Star) && matches!(tokens.last(), Some(Token::Star)) {
                continue;
            }
            tokens.push(token);
        }
        Self(tokens)
    }
    pub fn is_match(&self, value: PythonTextRef<'_>) -> bool {
        let points = value.codepoints();
        let mut cursor = Cursor::default();
        while let Some(&point) = points.get(cursor.input) {
            if !advance(&self.0, point, &mut cursor) {
                return false;
            }
        }
        self.0[cursor.pattern..]
            .iter()
            .all(|token| matches!(token, Token::Star))
    }
}
fn next_token(points: &[u32], at: &mut usize) -> Token {
    let point = points[*at];
    *at += 1;
    match point {
        42 => Token::Star,
        63 => Token::Any,
        91 => {
            if let Some(end) = class_end(points, *at) {
                let class = Class::compile(&points[*at..end]);
                *at = end + 1;
                Token::Class(class)
            } else {
                Token::Literal(point)
            }
        }
        _ => Token::Literal(point),
    }
}
#[derive(Default)]
struct Cursor {
    input: usize,
    pattern: usize,
    star: Option<(usize, usize)>,
}
fn advance(tokens: &[Token], point: u32, cursor: &mut Cursor) -> bool {
    match tokens.get(cursor.pattern) {
        Some(Token::Star) => {
            cursor.star = Some((cursor.pattern, cursor.input));
            cursor.pattern += 1;
        }
        Some(token) if token.accepts(point) => {
            cursor.pattern += 1;
            cursor.input += 1;
        }
        _ => {
            let Some((position, consumed)) = cursor.star else {
                return false;
            };
            cursor.input = consumed + 1;
            cursor.pattern = position + 1;
            cursor.star = Some((position, cursor.input));
        }
    }
    true
}
fn class_end(points: &[u32], start: usize) -> Option<usize> {
    let mut at = start;
    if points.get(at) == Some(&33) {
        at += 1;
    }
    if points.get(at) == Some(&93) {
        at += 1;
    }
    points[at..]
        .iter()
        .position(|&point| point == 93)
        .map(|offset| at + offset)
}

#[cfg(test)]
mod tests;
