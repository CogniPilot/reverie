//! Tokenization for the existing Hands command string. The resulting words
//! are data passed to journal operations and are never evaluated by a shell.

#[derive(Clone, Copy, PartialEq, Eq)]
enum Quoting {
    Unquoted,
    Single,
    Double,
}

pub(super) fn split(mut input: &str) -> Result<Vec<String>, &'static str> {
    let mut words = Vec::new();
    while !input.is_empty() {
        input = input.trim_start_matches(separator);
        if !input.is_empty() {
            words.push(read_word(&mut input)?);
        }
    }
    Ok(words)
}

fn separator(ch: char) -> bool {
    matches!(ch, ' ' | '\t' | '\r' | '\n')
}

fn read_word(input: &mut &str) -> Result<String, &'static str> {
    let mut word = String::new();
    let mut quoting = Quoting::Unquoted;
    while let Some(ch) = take_char(input) {
        match (quoting, ch) {
            (Quoting::Unquoted, ch) if separator(ch) => return Ok(word),
            (Quoting::Unquoted, '\'') => quoting = Quoting::Single,
            (Quoting::Unquoted, '"') => quoting = Quoting::Double,
            (Quoting::Single, '\'') | (Quoting::Double, '"') => quoting = Quoting::Unquoted,
            (Quoting::Unquoted | Quoting::Double, '\\') => {
                read_escape(input, &mut word, quoting)?;
            }
            (_, ch) => word.push(ch),
        }
    }
    if quoting == Quoting::Unquoted {
        Ok(word)
    } else {
        Err("No closing quotation")
    }
}

fn read_escape(input: &mut &str, word: &mut String, quoting: Quoting) -> Result<(), &'static str> {
    let next = take_char(input).ok_or("No escaped character")?;
    if quoting == Quoting::Double && !matches!(next, '"' | '\\') {
        word.push('\\');
    }
    word.push(next);
    Ok(())
}

fn take_char(input: &mut &str) -> Option<char> {
    let first = input.chars().next()?;
    *input = &input[first.len_utf8()..];
    Some(first)
}
