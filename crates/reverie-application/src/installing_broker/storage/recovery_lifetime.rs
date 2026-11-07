//! Structural retention only. An empty entry vector is never native process
//! settlement, stopped-container proof, or global unlock/capacity credit.
use super::StorageRegistry;
impl StorageRegistry {
    pub(in crate::installing_broker) fn known_empty_for_service_drop(&self) -> bool {
        self.entries
            .try_lock()
            .is_ok_and(|entries| entries.is_empty())
    }
}
