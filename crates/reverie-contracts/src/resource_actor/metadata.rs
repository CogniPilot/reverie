//! Original Engine.get json.loads(bytes) metadata, never a native capability.
use super::*;
mod website;
pub use website::QualifiedWebsiteMetadata;
pub const MAX_ENGINE_BODY: usize = 2 * 1024 * 1024;
/// Validate a closed Config/HostConfig/Mounts candidate using the actual actor
/// security policy. This checks DATA only, never a live website or authority.
pub fn validate_protected_website_settings(raw: &[u8]) -> Result<()> {
    website::validate_protected_website_settings(raw)
}
pub struct EngineMetadata(pub(super) Value);
impl EngineMetadata {
    pub fn decode(raw: &[u8]) -> Result<Self> {
        need(raw.len() <= MAX_ENGINE_BODY, "ENGINE_METADATA_UNAVAILABLE")?;
        legacy_json::decode_rootless_profile(raw)
            .map(Self)
            .map_err(|_| ResourceActorDataError("ENGINE_METADATA_UNAVAILABLE"))
    }
    pub fn equivalent(&self, other: &Self) -> bool {
        self.0.python_eq(&other.0)
    }
    /// The caller must supply the independently observed current host kernel.
    /// A matching JSON document alone is not a same-kernel engine proof.
    pub fn require_same_kernel(&self, engine_id: &str, kernel: &str) -> Result<()> {
        let same = |name: &str, expected: &str| {
            object(&self.0).ok().and_then(|fields| fields.get(&key(name)))
                .is_some_and(|value| matches!(&value.0, Node::String(value) if value.0 == expected.chars().map(u32::from).collect::<Vec<_>>()))
        };
        need(
            same("ID", engine_id) && same("OSType", "linux") && same("KernelVersion", kernel),
            "SAME_KERNEL_ENGINE_REQUIRED",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_preserves_python_bytes_last_duplicate_and_numeric_equality() {
        let raw = "{\"same\":0,\"same\":true}";
        let utf16: Vec<_> = [0xff, 0xfe]
            .into_iter()
            .chain(raw.encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        let actual = EngineMetadata::decode(&utf16).unwrap();
        let expected = EngineMetadata::decode(br#"{"same":1.0}"#).unwrap();
        assert!(actual.equivalent(&expected));
    }
    #[test]
    fn same_kernel_data_requires_all_three_exact_strings() {
        let valid =
            EngineMetadata::decode(br#"{"ID":"selected","OSType":"linux","KernelVersion":"host"}"#)
                .unwrap();
        valid.require_same_kernel("selected", "host").unwrap();
        assert!(valid.require_same_kernel("other", "host").is_err());
        assert!(valid.require_same_kernel("selected", "other").is_err());
        for raw in [
            b"[]".as_slice(),
            br#"{"ID":"selected","OSType":"windows","KernelVersion":"host"}"#,
            br#"{"ID":"selected","OSType":"linux","KernelVersion":true}"#,
        ] {
            assert!(
                EngineMetadata::decode(raw)
                    .unwrap()
                    .require_same_kernel("selected", "host")
                    .is_err()
            );
        }
    }
}
