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

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct NativeOperationId(String);
impl NativeOperationId {
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
