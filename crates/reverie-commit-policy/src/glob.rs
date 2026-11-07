//! Python `fnmatch.fnmatchcase`: `*` matches any run (including `/`), `?` one character,
//! `[...]` a set with `!` negation and `a-z` ranges; an unclosed `[` is literal.

#[derive(Debug, PartialEq, Eq)]
enum Token {
    Any,
    One,
    Literal(char),
    Set {
        negated: bool,
        items: Vec<(char, char)>,
    },
}

fn tokens(pattern: &str) -> Vec<Token> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        i += 1;
        match ch {
            '*' => {
                if out.last() != Some(&Token::Any) {
                    out.push(Token::Any);
                }
            }
            '?' => out.push(Token::One),
            '[' => match set(&chars, i) {
                Some((token, next)) => {
                    out.push(token);
                    i = next;
                }
                None => out.push(Token::Literal('[')),
            },
            _ => out.push(Token::Literal(ch)),
        }
    }
    out
}

/// Parses a set whose body starts at `start` (just after `[`); returns it and the index after `]`.
fn set(chars: &[char], start: usize) -> Option<(Token, usize)> {
    let mut end = start;
    if chars.get(end) == Some(&'!') {
        end += 1;
    }
    if chars.get(end) == Some(&']') {
        end += 1;
    }
    while chars.get(end).is_some_and(|&ch| ch != ']') {
        end += 1;
    }
    if end >= chars.len() {
        return None;
    }
    let mut body = &chars[start..end];
    let negated = body.first() == Some(&'!');
    if negated {
        body = &body[1..];
    }
    let mut items = Vec::new();
    let mut k = 0;
    while k < body.len() {
        if k + 2 < body.len() && body[k + 1] == '-' {
            // A reversed range matches nothing, as in the reference.
            if body[k] <= body[k + 2] {
                items.push((body[k], body[k + 2]));
            }
            k += 3;
        } else {
            items.push((body[k], body[k]));
            k += 1;
        }
    }
    Some((Token::Set { negated, items }, end + 1))
}

fn matches_one(token: &Token, ch: char) -> bool {
    match token {
        Token::Any | Token::One => true,
        Token::Literal(literal) => *literal == ch,
        Token::Set { negated, items } => {
            items.iter().any(|&(lo, hi)| (lo..=hi).contains(&ch)) != *negated
        }
    }
}

/// Case-sensitive shell-style match of the whole `name`.
pub(crate) fn fnmatchcase(name: &str, pattern: &str) -> bool {
    let tokens = tokens(pattern);
    let text: Vec<char> = name.chars().collect();
    // Classic wildcard matching with one backtrack point for the last `*`.
    let (mut t, mut p) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        match tokens.get(p) {
            Some(Token::Any) => {
                star = Some((p, t));
                p += 1;
            }
            Some(token) if matches_one(token, text[t]) => {
                t += 1;
                p += 1;
            }
            _ => match star {
                Some((star_p, star_t)) => {
                    p = star_p + 1;
                    t = star_t + 1;
                    star = Some((star_p, star_t + 1));
                }
                None => return false,
            },
        }
    }
    tokens[p..].iter().all(|token| *token == Token::Any)
}
