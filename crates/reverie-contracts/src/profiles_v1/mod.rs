//! `reverie-employee-resource-profiles-v1`: exact legacy compact ASCII bytes.
//! This codec owns one closed schema, not arbitrary JSON canonicalization.
mod decode;
mod encode;
mod text;

pub use decode::decode;
pub use encode::{encode, encode_profile};

use reverie_core::ValueError;
use reverie_core::profiles::{ProfileDocument, ProfileError, ResourceProfile};
use sha2::{Digest, Sha256};
use std::fmt;

pub const SCHEMA: &str = "reverie-employee-resource-profiles-v1";
pub const MAX_BYTES: usize = 131_072;
/// Python profile dictionary equality (including numeric CPU equality), distinct
/// from byte/digest identity and the encoding-sensitive checked-core Eq.
pub fn equivalent(
    left: &reverie_core::profiles::ResourceProfile,
    right: &reverie_core::profiles::ResourceProfile,
) -> bool {
    let value = |profile| {
        let bytes = encode_profile(profile).expect("bounded closed ASCII profile");
        crate::legacy_json::decode_utf8(&bytes).expect("profile encoder emits valid closed JSON")
    };
    value(left).python_eq(&value(right))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CodecError {
    StoreBound,
    ClosedSchema,
    DuplicateKey,
    StoreSchema,
    InvalidValue(ValueError),
    InvalidProfile(ProfileError),
}
impl CodecError {
    pub fn code(self) -> &'static str {
        match self {
            Self::StoreBound => "STORE_BOUND",
            Self::ClosedSchema => "CLOSED_SCHEMA",
            Self::DuplicateKey => "DUPLICATE_KEY",
            Self::StoreSchema => "STORE_SCHEMA",
            Self::InvalidValue(error) => error.code(),
            Self::InvalidProfile(error) => error.code(),
        }
    }
}
impl From<ValueError> for CodecError {
    fn from(value: ValueError) -> Self {
        Self::InvalidValue(value)
    }
}
impl From<ProfileError> for CodecError {
    fn from(value: ProfileError) -> Self {
        Self::InvalidProfile(value)
    }
}
impl fmt::Display for CodecError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for CodecError {}

/// Hashes identify bytes only, never owner approval or native completion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProfileDigest([u8; 32]);
impl ProfileDigest {
    pub fn to_hex(&self) -> String {
        crate::digest::hex(&self.0)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProfileDocumentDigest([u8; 32]);
impl ProfileDocumentDigest {
    pub fn to_hex(&self) -> String {
        crate::digest::hex(&self.0)
    }
}

pub fn profile_digest(profile: &ResourceProfile) -> Result<ProfileDigest, CodecError> {
    Ok(ProfileDigest(
        Sha256::digest(encode_profile(profile)?).into(),
    ))
}
pub fn document_digest(document: &ProfileDocument) -> Result<ProfileDocumentDigest, CodecError> {
    Ok(ProfileDocumentDigest(
        Sha256::digest(encode(document)?).into(),
    ))
}
