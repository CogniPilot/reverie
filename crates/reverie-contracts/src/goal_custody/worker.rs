//! Named view of the actual worker snapshot, never a second configuration or
//! a request-selected native path. Filesystem/peer checks stay with the host.
use super::configuration::absolute;
use super::*;
use crate::{
    legacy_json::truthy, storage_identity::MetadataText, worker_config::EffectiveWorkerConfig,
};
use reverie_core::posix_path::PosixPath;

pub struct GoalWorkerSettings {
    configuration: EffectiveWorkerConfig,
    private: MetadataText,
    company: MetadataText,
    socket: PosixPath,
    mounts: Vec<PosixPath>,
}
impl GoalWorkerSettings {
    pub fn capture(configuration: &EffectiveWorkerConfig) -> Result<Self> {
        let fields = object(configuration.as_value()).map_err(|_| GoalDataError::Worker)?;
        let private = MetadataText::from_text(text(field(fields, "goalPrivateConfig")?)?.clone());
        if private.codepoints().is_empty() {
            return Err(GoalDataError::Worker);
        }
        let company = MetadataText::from_text(text(field(fields, "companyFile")?)?.clone());
        let socket = absolute(field(fields, "socket")?)?;
        let Some(Value(Node::Array(mounts))) = fields.get(&key("mounts")) else {
            return Err(GoalDataError::Worker);
        };
        let mounts = mounts
            .iter()
            .map(|mount| absolute(field(object(mount)?, "source")?))
            .collect::<Result<_>>()?;
        Ok(Self {
            configuration: configuration.clone(),
            private,
            company,
            socket,
            mounts,
        })
    }
    pub fn private_configuration(&self) -> &MetadataText {
        &self.private
    }
    pub fn company_file(&self) -> &MetadataText {
        &self.company
    }
    pub fn socket(&self) -> &PosixPath {
        &self.socket
    }
    pub fn mounts(&self) -> &[PosixPath] {
        &self.mounts
    }
    pub fn require_no_gpu_grants(&self) -> Result<()> {
        let fields = object(self.configuration.as_value())?;
        if truthy(fields.get(&key("gpuGrants"))) {
            Err(GoalDataError::Inventory)
        } else {
            Ok(())
        }
    }
    /// Goal's private_json uses ordinary json.loads(bytes), including last
    /// duplicate wins, independently of the normal worker file loader.
    pub fn matches_private_worker_bytes(&self, raw: &[u8]) -> Result<bool> {
        let decoded =
            legacy_json::decode_worker_request_bytes(raw).map_err(|_| GoalDataError::Json)?;
        Ok(decoded.value.python_eq(self.configuration.as_value()))
    }
}
