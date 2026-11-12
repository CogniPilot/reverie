//! Publication DATA only. Changing the configuration domain cannot change
//! the installed engine, website, code, client or provenance selection.
use super::*;
use crate::worker_config::EffectiveWorkerConfig;

impl InstalledFactsDocument {
    pub fn rebound_configuration_bytes(
        raw: &[u8],
        before: &EffectiveWorkerConfig,
        after: &EffectiveWorkerConfig,
    ) -> Result<Vec<u8>> {
        let original = Self::decode(raw)?;
        let selected = ResourceActorSettings::capture(before)?;
        let next = ResourceActorSettings::capture(after)?;
        selected.require_document(&original)?;
        need(
            selected.path().codepoints() == next.path().codepoints()
                && selected.root().codepoints() == next.root().codepoints()
                && selected.uid() == next.uid()
                && selected.gid() == next.gid(),
            "RESOURCE_INSTALL_REBIND_SELECTION_CHANGED",
        )?;
        let mut value = legacy_json::decode_strict_bytes(raw)
            .map_err(|_| ResourceActorDataError("RESOURCE_INSTALL_CLOSED_SCHEMA"))?;
        let Node::Object(fields) = &mut value.0 else {
            return Err(ResourceActorDataError("RESOURCE_INSTALL_CLOSED_SCHEMA"));
        };
        let domain = fields
            .get_mut(&key("configurationDigest"))
            .ok_or(ResourceActorDataError("RESOURCE_INSTALL_CLOSED_SCHEMA"))?;
        *domain = Value(Node::String(key(next.domain().as_str())));
        // Encode the same complete lossless object: no field projection or
        // reconstruction of any installed program/path/security fact occurs.
        let bytes = crate::worker_config::compact_data(&value);
        next.require_document(&Self::decode(&bytes)?)?;
        Ok(bytes)
    }
}
