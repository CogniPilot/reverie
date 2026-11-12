//! Fleet output only. Requests and ordinary replies retain their 8 KiB budget.
//! Only closed reply producers construct these already encoded DATA bytes.
use super::*;

pub const FLEET_REPLY_MAX_FRAME: usize = 65_536;

pub struct FleetReplyFrame {
    bytes: Vec<u8>,
}
impl FleetReplyFrame {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub(super) fn encode(value: Value) -> Result<Self> {
        let raw = crate::worker_config::compact_data(&value);
        let frame = HumanFrame::decode_bounded(&raw, FLEET_REPLY_MAX_FRAME).map_err(frame_error)?;
        let bytes = frame
            .canonical_bounded(FLEET_REPLY_MAX_FRAME)
            .map_err(frame_error)?;
        Ok(Self { bytes })
    }
}

/// An encoded prospective result, never a completion or permission to drain.
/// The two digest slots have their exact checked wire width before effects.
pub struct PreparedFleetMigrationReply {
    frame: FleetReplyFrame,
    configuration: usize,
    domain: usize,
}
impl PreparedFleetMigrationReply {
    pub(super) fn prepare(value: Value) -> Result<Self> {
        let frame = FleetReplyFrame::encode(value)?;
        let slot = |name: &str| -> Result<usize> {
            let marker = format!("\"{name}\":\"{}\"", "0".repeat(64));
            let offset = frame
                .bytes
                .windows(marker.len())
                .position(|bytes| bytes == marker.as_bytes())
                .ok_or(ResourceActorDataError("POOL_MIGRATION_REPLY_SLOT"))?;
            Ok(offset + name.len() + 4)
        };
        let configuration = slot("configurationDigest")?;
        let domain = slot("domainDigest")?;
        Ok(Self {
            frame,
            configuration,
            domain,
        })
    }
    /// Fill only actual publication receipt digests. No encoding, bound check,
    /// cohort reconstruction or fallible response construction remains here.
    pub fn finish(
        mut self,
        configuration: &crate::worker_config::WorkerConfigDigest,
        domain: &crate::reservation_control::ControlDomainDigest,
    ) -> FleetReplyFrame {
        self.frame.bytes[self.configuration..self.configuration + 64]
            .copy_from_slice(configuration.to_hex().as_bytes());
        self.frame.bytes[self.domain..self.domain + 64].copy_from_slice(domain.to_hex().as_bytes());
        self.frame
    }
}
