//! Phase-0 metadata predicate. A receipt represents synthetic evaluation alone.
mod receipt;
mod replay;
mod request;

use crate::{digest, legacy_json, worker_config};
use request::Input;
use serde::{Deserialize, Deserializer, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};

pub use receipt::Receipt;
pub use replay::{Replay, ReplayError};

pub const INPUT_LIMIT: usize = 65_536;
const MAX_ROOMS: usize = 16;
const MAX_MESSAGES: usize = 256;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const MAX_AGE_MS: u64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidInput;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidReceipt;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(try_from = "String")]
struct Id(String);

impl TryFrom<String> for Id {
    type Error = InvalidInput;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        let mut bytes = value.bytes();
        if value.len() <= 96
            && bytes
                .next()
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
            && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            Ok(Self(value))
        } else {
            Err(InvalidInput)
        }
    }
}

impl std::fmt::Display for InvalidInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("GUARD_INPUT_INVALID")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(try_from = "u64")]
struct Counter(u64);

impl TryFrom<u64> for Counter {
    type Error = InvalidInput;
    fn try_from(value: u64) -> Result<Self, Self::Error> {
        (value <= MAX_SAFE_INTEGER)
            .then_some(Self(value))
            .ok_or(InvalidInput)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(try_from = "Counter")]
struct Positive(Counter);

impl TryFrom<Counter> for Positive {
    type Error = InvalidInput;
    fn try_from(value: Counter) -> Result<Self, Self::Error> {
        (value.0 > 0).then_some(Self(value)).ok_or(InvalidInput)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum Code {
    GuardPass,
    GuardGenChanged,
    GuardStateNotActive,
    GuardApiUnavailable,
    GuardUnreadInstruction,
    GuardInputInvalid,
    GuardReceiptInvalid,
    IdempotencyConflict,
    AdapterUnavailable,
}

// Both v1 nullable identifiers are required keys.
fn required_nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    decoder: D,
) -> Result<Option<T>, D::Error> {
    Option::deserialize(decoder)
}

fn decode<T: DeserializeOwned>(raw: &[u8]) -> Result<T, InvalidInput> {
    if raw.len() > INPUT_LIMIT {
        return Err(InvalidInput);
    }
    // Reuse the bytes JSON reader for encoding detection, strict constants and
    // duplicate keys, then use the closed v1 types for field-level validation.
    let value = legacy_json::decode_strict_bytes(raw).map_err(|_| InvalidInput)?;
    serde_json::from_slice(&worker_config::compact_data(&value)).map_err(|_| InvalidInput)
}

fn canonical_value<T: Serialize>(value: &T) -> serde_json::Value {
    let mut value = serde_json::to_value(value).expect("validated v1 JSON fields");
    value.sort_all_objects();
    value
}

fn canonical<T: Serialize>(value: &T) -> Vec<u8> {
    serde_json::to_vec(&canonical_value(value)).expect("validated v1 JSON fields")
}

fn sha256<T: Serialize>(value: &T) -> String {
    digest::hex(&Sha256::digest(canonical(value)).into())
}

/// Validated metadata and time from the same v1 input. No effect authority.
pub struct Snapshot(Input);

impl Snapshot {
    pub fn decode(raw: &[u8]) -> Result<Self, InvalidInput> {
        let input: Input = decode(raw)?;
        input.request.validate()?;
        Ok(Self(input))
    }

    pub fn evaluate(&self) -> Receipt {
        let Input { request, now_ms } = &self.0;
        Receipt::new(request, *now_ms)
    }
}
