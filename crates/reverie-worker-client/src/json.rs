//! Duplicate-free, integer-only JSON for closed metadata replies.
use crate::{Error, Result};
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};
use std::fmt;

struct Closed(Value);
impl<'de> Deserialize<'de> for Closed {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> std::result::Result<Self, D::Error> {
        decoder.deserialize_any(ClosedVisitor).map(Self)
    }
}
struct ClosedVisitor;
impl<'de> Visitor<'de> for ClosedVisitor {
    type Value = Value;
    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("closed integer-only JSON")
    }
    fn visit_bool<E: de::Error>(self, value: bool) -> std::result::Result<Value, E> {
        Ok(value.into())
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> std::result::Result<Value, E> {
        Ok(value.into())
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> std::result::Result<Value, E> {
        Ok(value.into())
    }
    fn visit_f64<E: de::Error>(self, value: f64) -> std::result::Result<Value, E> {
        // The lexical gate has already rejected every float token. serde's
        // deserialize_any represents the legacy integer spelling -0 as f64.
        if value == 0.0 && value.is_sign_negative() {
            Ok(0.into())
        } else {
            Err(de::Error::custom("integer token required"))
        }
    }
    fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Value, E> {
        Ok(value.into())
    }
    fn visit_string<E: de::Error>(self, value: String) -> std::result::Result<Value, E> {
        Ok(value.into())
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> std::result::Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(Closed(value)) = sequence.next_element()? {
            values.push(value);
        }
        Ok(values.into())
    }
    fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> std::result::Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some((key, Closed(value))) = access.next_entry::<String, Closed>()? {
            if values.insert(key, value).is_some() {
                return Err(de::Error::custom("duplicate field"));
            }
        }
        Ok(values.into())
    }
}
pub(crate) fn decode(raw: &[u8]) -> Result<Value> {
    integer_tokens(raw)?;
    serde_json::from_slice::<Closed>(raw)
        .map(|value| value.0)
        .map_err(|_| Error("Invalid closed metadata"))
}
fn integer_tokens(raw: &[u8]) -> Result<()> {
    let (mut string, mut escaped, mut index) = (false, false, 0);
    while index < raw.len() {
        let byte = raw[index];
        if string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                string = false;
            }
        } else if byte == b'"' {
            string = true;
        } else if byte == b'-' || byte.is_ascii_digit() {
            let start = index;
            while index < raw.len() && !b" \t\r\n,]}".contains(&raw[index]) {
                index += 1;
            }
            let token = &raw[start..index];
            let unsigned = token.strip_prefix(b"-").unwrap_or(token);
            need(
                token.len() <= 10
                    && !unsigned.is_empty()
                    && unsigned.iter().all(u8::is_ascii_digit),
            )?;
            continue;
        }
        index += 1;
    }
    Ok(())
}
pub(crate) fn closed<'a>(value: &'a Value, fields: &[&str]) -> Result<&'a Map<String, Value>> {
    let map = value.as_object().ok_or(Error("Invalid closed metadata"))?;
    if map.len() != fields.len() || !fields.iter().all(|field| map.contains_key(*field)) {
        return Err(Error("Invalid closed metadata"));
    }
    Ok(map)
}
pub(crate) fn need(value: bool) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(Error("Invalid closed metadata"))
    }
}

#[cfg(test)]
mod tests {
    use super::decode;
    #[test]
    fn integer_spellings_and_string_escape_boundaries_remain_strict() {
        for raw in [
            "-0",
            "0",
            "2147483647",
            "-255",
            r#"{"a":"escaped \" 1.2 and \\ -0e0","b":-0}"#,
        ] {
            assert!(decode(raw.as_bytes()).is_ok(), "{raw}");
        }
        assert_eq!(decode(b"-0").unwrap(), serde_json::json!(0));
        for raw in [
            "-0.0",
            "-0e0",
            "0.0",
            "1e0",
            "NaN",
            "Infinity",
            "12345678901",
            "-1234567890",
            r#"{"a":1,"\u0061":2}"#,
            r#"{"a":{"b":0,"b":1}}"#,
            r#"{"a":"\\","b":0.0}"#,
        ] {
            assert!(decode(raw.as_bytes()).is_err(), "{raw}");
        }
    }
}
