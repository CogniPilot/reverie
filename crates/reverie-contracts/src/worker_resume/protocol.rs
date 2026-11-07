use super::*;
use crate::human_protocol::{HumanFrame, HumanFrameError};
/// Lossless ordered frame DATA. Native authentication and state remain with
/// the actual accepted Record; this value is never a channel or peer token.
pub struct ResumeFrame {
    frame: HumanFrame,
}
impl ResumeFrame {
    pub fn decode(raw: &[u8]) -> Result<Self> {
        Ok(Self {
            frame: HumanFrame::decode(raw).map_err(frame_error)?,
        })
    }
    pub fn require_registration(&self) -> Result<()> {
        let code = "Native host recovery registration is unavailable";
        let fields = object(self.frame.value(), code)?;
        need(fields.len() == 3, code)?;
        let text = |name, expected| matches!(field(fields,name),Some(Value(Node::String(value)))if value.equals_ascii(expected));
        need(text("purpose", PURPOSE) && text("kind", "register"), code)?;
        // Original dict equality deliberately accepts True and 1.0 here.
        need(
            matches!(field(fields,"version"),Some(value)if legacy_json::numeric_key(&value.0).as_deref()==Some("1")),
            code,
        )
    }
    pub fn canonical(&self) -> Result<Vec<u8>> {
        self.frame.canonical().map_err(frame_error)
    }
    pub fn decode_canonical(raw: &[u8]) -> Result<Self> {
        Ok(Self {
            frame: HumanFrame::decode_canonical(raw).map_err(frame_error)?,
        })
    }
}
fn frame_error(error: HumanFrameError) -> ResumeDataError {
    ResumeDataError(error.code())
}
