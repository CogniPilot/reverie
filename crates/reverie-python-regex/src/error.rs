use std::sync::Arc;

/// Python-codepoint diagnostics; formatting into Rust text is a convenience,
/// not permission to discard an accepted surrogate in a structured reply.
#[derive(Clone, Debug)]
pub struct RegexError {
    pub(crate) message: Vec<u32>,
    pub(crate) position: Option<usize>,
    pub(crate) pattern: Arc<[u32]>,
    pub(crate) kind: &'static str,
}
impl RegexError {
    pub(crate) fn new(pattern: &Arc<[u32]>, message: &str, position: Option<usize>) -> Self {
        Self {
            message: message.chars().map(u32::from).collect(),
            position,
            pattern: pattern.clone(),
            kind: "PatternError",
        }
    }
    pub fn codepoints(&self) -> Vec<u32> {
        let mut text = self.message.clone();
        if let Some(position) = self.position {
            text.extend(format!(" at position {position}").chars().map(u32::from));
            if self.pattern.contains(&10) {
                let before = &self.pattern[..position.min(self.pattern.len())];
                let line = 1 + before.iter().filter(|&&cp| cp == 10).count();
                let column = before
                    .iter()
                    .rposition(|&cp| cp == 10)
                    .map_or(position + 1, |index| position - index);
                text.extend(
                    format!(" (line {line}, column {column})")
                        .chars()
                        .map(u32::from),
                );
            }
        }
        text
    }
    pub fn kind(&self) -> &'static str {
        self.kind
    }
}
impl std::fmt::Display for RegexError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for point in self.codepoints() {
            if let Some(point) = char::from_u32(point) {
                write!(output, "{point}")?;
            } else {
                write!(output, "\\u{point:04x}")?;
            }
        }
        Ok(())
    }
}
impl std::error::Error for RegexError {}
pub(crate) type Result<T> = std::result::Result<T, RegexError>;
