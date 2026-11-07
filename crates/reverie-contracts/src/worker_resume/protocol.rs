use super::*;
use legacy_json::{HumanParseError, ordered::OrderedValue};
/// Lossless ordered frame DATA. Native authentication and state remain with
/// the actual accepted Record; this value is never a channel or peer token.
pub struct ResumeFrame {
    pub(super) data: OrderedValue,
}
impl ResumeFrame {
    pub fn decode(raw: &[u8]) -> Result<Self> {
        need(raw.len() <= 8192, "REQUEST_BOUND")?;
        depth(raw)?;
        let data = legacy_json::decode_human_protocol_bytes(raw).map_err(|error| {
            ResumeDataError(match error {
                HumanParseError::Json(legacy_json::Error::DuplicateKey) => "DUPLICATE_KEY",
                HumanParseError::Json(_) => "MALFORMED_PROTOCOL_JSON",
                HumanParseError::Integer => "INTEGER_TOKEN_BOUND",
                HumanParseError::Nonfinite => "NONFINITE_JSON",
            })
        })?;
        Ok(Self { data })
    }
    pub fn require_registration(&self) -> Result<()> {
        let code = "Native host recovery registration is unavailable";
        let fields = object(&self.data.value, code)?;
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
        finite(self.data.first_nonfinite())?;
        let raw = self.data.encode_compact();
        need(!raw.is_empty() && raw.len() <= 8192, "FRAME_BOUND")?;
        Ok(raw)
    }
    pub fn decode_canonical(raw: &[u8]) -> Result<Self> {
        let value = Self::decode(raw)?;
        need(value.canonical()? == raw, "NONCANONICAL_FRAME")?;
        Ok(value)
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
