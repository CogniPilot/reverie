//! Fixed private draft publication. Paths derive only from captured installing
//! configuration and checked draft IDs; no public raw writer is exposed.
use super::*;
use reverie_contracts::{reservation_draft::DraftRecord, storage_identity::Metadata};
use reverie_core::operations::JournalId;

pub fn read_draft(config: &ReservationConfiguration, id: &JournalId) -> Result<Metadata> {
    super::history::read_receipt(config, &format!("draft-{}.json", id.as_str()))
}
pub fn publish_draft(config: &ReservationConfiguration, record: &DraftRecord) -> Result<()> {
    super::private_record::publish(config, super::private_record::PrivateRecord::Draft(record))
}
