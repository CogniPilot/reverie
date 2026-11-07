//! Original human_terminal_protocol and FramedChannel DATA, shared by native
//! resource and resume actors. A frame grants no channel, peer or owner action.
use crate::legacy_json::{self, HumanParseError, ordered::OrderedValue};
use std::fmt;

pub const MAX_FRAME: usize = 8192;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HumanFrameError(&'static str);
impl HumanFrameError {
    pub fn code(self) -> &'static str {
        self.0
    }
}
impl fmt::Display for HumanFrameError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.0)
    }
}
impl std::error::Error for HumanFrameError {}
type Result<T> = std::result::Result<T, HumanFrameError>;
pub struct HumanFrame(OrderedValue);
impl HumanFrame {
    pub fn decode(raw: &[u8]) -> Result<Self> {
        need(raw.len() <= MAX_FRAME, "REQUEST_BOUND")?;
        depth(raw)?;
        legacy_json::decode_human_protocol_bytes(raw)
            .map(Self)
            .map_err(|error| {
                HumanFrameError(match error {
                    HumanParseError::Json(legacy_json::Error::DuplicateKey) => "DUPLICATE_KEY",
                    HumanParseError::Json(_) => "MALFORMED_PROTOCOL_JSON",
                    HumanParseError::Integer => "INTEGER_TOKEN_BOUND",
                    HumanParseError::Nonfinite => "NONFINITE_JSON",
                })
            })
    }
    pub(crate) fn value(&self) -> &legacy_json::Value {
        &self.0.value
    }
    pub fn canonical(&self) -> Result<Vec<u8>> {
        finite(self.0.first_nonfinite())?;
        let raw = self.0.encode_compact();
        need(!raw.is_empty() && raw.len() <= MAX_FRAME, "FRAME_BOUND")?;
        Ok(raw)
    }
    pub fn decode_canonical(raw: &[u8]) -> Result<Self> {
        let value = Self::decode(raw)?;
        need(value.canonical()? == raw, "NONCANONICAL_FRAME")?;
        Ok(value)
    }
}
fn need(ok: bool, code: &'static str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(HumanFrameError(code))
    }
}
pub(crate) fn finite(name: Option<&str>) -> Result<()> {
    match name {
        None => Ok(()),
        Some("-inf") => Err(HumanFrameError(
            "Out of range float values are not JSON compliant: -inf",
        )),
        Some("inf") => Err(HumanFrameError(
            "Out of range float values are not JSON compliant: inf",
        )),
        Some(_) => Err(HumanFrameError(
            "Out of range float values are not JSON compliant: nan",
        )),
    }
}
fn depth(raw: &[u8]) -> Result<()> {
    let (mut nesting, mut quoted, mut escaped) = (0_i32, false, false);
    for &byte in raw {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
        } else {
            match byte {
                b'"' => quoted = true,
                b'[' | b'{' => {
                    nesting += 1;
                    need(nesting <= 8, "REQUEST_DEPTH")?;
                }
                b']' | b'}' => {
                    nesting -= 1;
                    need(nesting >= 0, "REQUEST_DEPTH")?;
                }
                _ => (),
            }
        }
    }
    need(nesting == 0 && !quoted, "REQUEST_SYNTAX")
}
