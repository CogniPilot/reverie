//! Named original human_terminal_protocol parse hooks, reused by resume.
//! Lexing, number prefixes, ordered objects and encoding stay single-owned.
use super::*;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HumanParseError {
    Json(Error),
    Integer,
    Nonfinite,
}
pub(super) fn decode(
    source: &[u8],
) -> Result<super::super::ordered::OrderedValue, HumanParseError> {
    let mut cursor = Cursor::new(source, Purpose::Human);
    ordered::with_cursor(&mut cursor)
        .map_err(|error| cursor.human_error.unwrap_or(HumanParseError::Json(error)))
}
pub(super) fn integer(token: &str) -> bool {
    let digits = token.strip_prefix('-').unwrap_or(token);
    digits.len() <= 16
        && digits.bytes().all(|byte| byte.is_ascii_digit())
        && (digits.len() < 16 || digits <= "9007199254740991")
}
impl Cursor<'_> {
    pub(super) fn human_failure<T>(&mut self, error: HumanParseError) -> Result<T, Error> {
        self.human_error = Some(error);
        Err(Error::InvalidJson)
    }
}
