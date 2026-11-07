//! Exact managed AGENTS text transformation; no filesystem or owner authority.
const START: &str = "<!-- reverie-laptop-storage -->";
const END: &str = "<!-- /reverie-laptop-storage -->";
const INSTRUCTIONS: &str = include_str!("instructions.txt");
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InstructionDataError {
    Bound,
    Utf8,
    Ambiguous,
}
impl std::fmt::Display for InstructionDataError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "STORAGE_INSTRUCTIONS_{self:?}")
    }
}
impl std::error::Error for InstructionDataError {}
/// Input bound counts raw bytes. Output has no invented extra bound: the
/// source may add its marked block to an already-full accepted owner file.
pub fn storage_instruction_bytes(raw: &[u8]) -> Result<Vec<u8>, InstructionDataError> {
    if raw.len() > 65536 {
        return Err(InstructionDataError::Bound);
    }
    let text = std::str::from_utf8(raw).map_err(|_| InstructionDataError::Utf8)?;
    let block = format!("{START}\n{INSTRUCTIONS}{END}");
    let result = if text.contains(START) || text.contains(END) {
        if text.matches(START).count() != 1 || text.matches(END).count() != 1 {
            return Err(InstructionDataError::Ambiguous);
        }
        let start = text.find(START).expect("counted start");
        let end = text.find(END).expect("counted end");
        if end < start {
            return Err(InstructionDataError::Ambiguous);
        }
        format!("{}{block}{}", &text[..start], &text[end + END.len()..])
    } else {
        format!(
            "{text}{}{block}\n",
            if text.is_empty() { "" } else { "\n\n" }
        )
    };
    Ok(result.into_bytes())
}
