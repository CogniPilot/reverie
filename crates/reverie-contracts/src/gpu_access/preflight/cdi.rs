use super::*;
use crate::storage_identity::MetadataText;
use reverie_core::operations::JournalDigest;

pub struct PreflightCdiData {
    path: MetadataText,
    digest: JournalDigest,
    projection: CdiPreflightEdits,
}
impl PreflightCdiData {
    pub fn new(path: MetadataText, digest: JournalDigest, projection: CdiPreflightEdits) -> Self {
        Self {
            path,
            digest,
            projection,
        }
    }
    pub fn edits(&self) -> &CdiSelectedEdits {
        self.projection.edits()
    }
    pub fn encode(&self) -> Result<Vec<u8>> {
        let value = self.value()?;
        if !value.is_finite() {
            return Err(GpuDataError::CdiDocument);
        }
        Ok(crate::worker_config::encode_data(&value))
    }
    pub(crate) fn value(&self) -> Result<Value> {
        let edits = self.edits();
        Ok(Value(Node::Object(
            [
                (
                    key("path"),
                    Value(Node::String(Text(self.path.codepoints().to_vec()))),
                ),
                (key("sha256"), string(self.digest.as_str())),
                (key("deviceNodePaths"), self.projection.paths_value()?),
                (key("mountCount"), number(edits.mount_count() as u64)),
                (
                    key("allMountsReadonly"),
                    Value(Node::Bool(edits.all_mounts_readonly())),
                ),
                (key("hookCount"), number(edits.hook_count() as u64)),
                (key("hostPolicyReviewRequired"), Value(Node::Bool(true))),
            ]
            .into(),
        )))
    }
}
