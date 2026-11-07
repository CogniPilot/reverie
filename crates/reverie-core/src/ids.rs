//! Purpose-specific UUID values; these are references, never authorization.
use crate::ValueError;
use std::fmt;

fn canonical(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(offset, byte)| {
            if [8, 13, 18, 23].contains(&offset) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}

macro_rules! profile_id {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
        pub struct $name(String);
        impl $name {
            /// Legacy profiles accept lexical lowercase UUIDs, including nil.
            pub fn parse(value: &str) -> Result<Self, ValueError> {
                if !canonical(value) {
                    return Err(ValueError::CanonicalUuid);
                }
                Ok(Self(value.to_owned()))
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl fmt::Display for $name {
            fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
                output.write_str(&self.0)
            }
        }
    };
}

profile_id!(ProfileEmployeeId);
profile_id!(ProfileSessionId);

/// A complete engine inventory reference, never process/effect authority.
/// The legacy observer accepts the all-zero lexical ID as well.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ContainerId(String);
impl ContainerId {
    pub fn parse(value: &str) -> Result<Self, ValueError> {
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(ValueError::ContainerId);
        }
        Ok(Self(value.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct NativeOperationId(String);
impl NativeOperationId {
    /// Format supplied entropy with UUIDv4 version/variant bits. Entropy
    /// acquisition belongs to the native caller; this value is only a name.
    pub fn from_random_bytes(mut bytes: [u8; 16]) -> Self {
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let hex = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Self(format!(
            "{}-{}-{}-{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..]
        ))
    }
    pub fn parse(value: &str) -> Result<Self, ValueError> {
        if !canonical(value) {
            return Err(ValueError::NativeUuid);
        }
        if value.bytes().all(|byte| byte == b'0' || byte == b'-') {
            return Err(ValueError::NilOperationId);
        }
        Ok(Self(value.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const NIL: &str = "00000000-0000-0000-0000-000000000000";
    #[test]
    fn supplied_entropy_uuid_format_matches_actual_python_version_four() {
        assert_eq!(
            NativeOperationId::from_random_bytes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
                .as_str(),
            "00000000-0000-4000-8000-000000000000"
        );
        assert_eq!(
            NativeOperationId::from_random_bytes([
                255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255
            ])
            .as_str(),
            "ffffffff-ffff-4fff-bfff-ffffffffffff"
        );
        assert_eq!(
            NativeOperationId::from_random_bytes([
                0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
            ])
            .as_str(),
            "00010203-0405-4607-8809-0a0b0c0d0e0f"
        );
    }
    #[test]
    fn container_references_require_complete_lowercase_engine_ids() {
        assert!(ContainerId::parse(&"0".repeat(64)).is_ok());
        assert!(ContainerId::parse(&"a".repeat(64)).is_ok());
        for value in [
            "a".repeat(63),
            "a".repeat(65),
            "A".repeat(64),
            format!("{};", "a".repeat(63)),
            "--all".to_owned(),
        ] {
            assert!(ContainerId::parse(&value).is_err());
        }
    }
    #[test]
    fn profile_compatibility_does_not_weaken_native_operation_identity() {
        assert!(ProfileEmployeeId::parse(NIL).is_ok());
        assert!(ProfileSessionId::parse(NIL).is_ok());
        assert_eq!(NativeOperationId::parse("w1").unwrap_err().code(), "UUID");
        assert_eq!(
            NativeOperationId::parse(NIL),
            Err(ValueError::NilOperationId)
        );
        for value in [
            "w1",
            "force-old",
            "AAAAAAAA-0000-0000-0000-000000000000",
            "000000000000000000000000000000000000",
        ] {
            assert!(ProfileEmployeeId::parse(value).is_err());
        }
    }
}
