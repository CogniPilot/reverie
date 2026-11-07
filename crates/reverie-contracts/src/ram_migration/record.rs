use super::*;
pub(super) fn encode(
    profile: &ResourceProfile,
    source: &NativeLimitBinding,
    effective: &EffectiveWorkerConfig,
    memory: &ProjectedMemoryPolicy,
) -> Result<(Vec<u8>, JournalDigest)> {
    let string = |value: &str| Value(Node::String(key(value)));
    let source_digest = crate::reservation_control::fingerprint(source.data())
        .map_err(|_| RamMigrationError::Fingerprint)?;
    let fields = BTreeMap::from([
        (key("schema"), string("reverie-ram-migration-policy-v1")),
        (
            key("profileDigest"),
            string(
                &profiles_v1::profile_digest(profile)
                    .map_err(|_| RamMigrationError::Profile)?
                    .to_hex(),
            ),
        ),
        (
            key("sourceContainerId"),
            string(source.container_id().as_str()),
        ),
        (
            key("sourceBindingDigest"),
            string(&crate::digest::hex(&source_digest)),
        ),
        (
            key("sourceConfigDigest"),
            string(&worker_config::config_digest(effective).to_hex()),
        ),
        (
            key("sourcePolicyDigest"),
            string(&worker_config::policy_digest(effective).to_hex()),
        ),
        (key("memoryPolicy"), memory::projected_value(memory)),
    ]);
    let value = Value(Node::Object(fields));
    let digest = crate::reservation_control::fingerprint(&value)
        .map_err(|_| RamMigrationError::Fingerprint)?;
    Ok((
        worker_config::compact_data(&value),
        JournalDigest::parse(&crate::digest::hex(&digest)).expect("SHA256"),
    ))
}
