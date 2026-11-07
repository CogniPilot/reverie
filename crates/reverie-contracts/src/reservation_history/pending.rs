use super::*;
use reverie_core::operations::{JournalId, OperationDocument, OperationState};

/// Position includes every native entry, even filenames not selected for read.
pub fn validate_pending_position(zero_based: usize) -> Result<()> {
    need(
        zero_based < reverie_core::operations::MAX_SETTLEMENT_ENTRIES,
        HistoryError::PendingBound,
    )
}

/// The caller retains actual directory enumeration order/count. A matching
/// pending filename must contain a canonical nonnil journal operation ID.
pub fn pending_operation_id(points: &[u32]) -> Result<Option<JournalId>> {
    let prefix = "settlement-".bytes().map(u32::from).collect::<Vec<_>>();
    let suffix = ".pending.json".bytes().map(u32::from).collect::<Vec<_>>();
    if !points.starts_with(&prefix) || !points.ends_with(&suffix) {
        return Ok(None);
    }
    let end = points.len() - suffix.len();
    let text = points[prefix.len()..end]
        .iter()
        .map(|&cp| char::from_u32(cp))
        .collect::<Option<String>>()
        .ok_or(HistoryError::Journal(OperationError::new("UUID")))?;
    Ok(Some(JournalId::parse(&text)?))
}
pub fn validate_pending(
    id: &JournalId,
    metadata: &Metadata,
    document: &OperationDocument,
) -> Result<()> {
    let root = exact(
        metadata.as_value(),
        &[
            "schema",
            "operationId",
            "reservationId",
            "verifiedReceiptDigest",
        ],
    )?;
    let op = document.operations().get(id).map(|op| op.data());
    need(
        equals(
            get(root, "schema"),
            "reverie-resource-settlement-pending-v1",
        ) && equals(get(root, "operationId"), id.as_str())
            && op.is_some_and(|op| {
                matches!(
                    op.state,
                    OperationState::VerifyRecorded | OperationState::Completed
                ) && equals(get(root, "reservationId"), op.reservation_id.as_str())
            }),
        HistoryError::Pending,
    )?;
    digest_field(field(root, "verifiedReceiptDigest")?)?;
    Ok(())
}
