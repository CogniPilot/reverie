use super::*;
use reverie_core::{
    ids::ProfileEmployeeId,
    operations::{Operation, OperationState},
    profiles::ResourceProfile,
};

/// Checked first historical receipt phase. The caller must read the fixed
/// verified receipt only after capture; pending absence is checked last.
pub struct HistoricalCompletion {
    receipt: Value,
    operation: Operation,
    verified: Value,
    profile_digest: JournalDigest,
}
impl HistoricalCompletion {
    pub fn capture(operation: &Operation, metadata: &Metadata) -> Result<Self> {
        let op = operation.data();
        need(
            op.state == OperationState::Completed,
            HistoryError::Operation,
        )?;
        let value = metadata.as_value();
        let receipt = exact(
            value,
            &[
                "schema",
                "operationId",
                "reservationId",
                "beforeOperationDigest",
                "verifiedReceiptDigest",
                "profile",
                "nativeFacts",
                "normalSession",
                "planRecord",
                "state",
            ],
        )?;
        need(
            equals(
                get(receipt, "schema"),
                "reverie-resource-native-completion-v1",
            ) && equals(get(receipt, "state"), "COMPLETED_NATIVE_SETTLED")
                && equals(get(receipt, "operationId"), op.id.as_str())
                && equals(get(receipt, "reservationId"), op.reservation_id.as_str())
                && Some(digest(value)?) == op.last_receipt_digest,
            HistoryError::Receipt,
        )?;
        // Preserve source comparison: the verified digest is unvalidated DATA
        // in this reconstructed operation, not a newly accepted journal row.
        let mut before = crate::operations_v1::operation(operation);
        let Node::Object(before_fields) = &mut before.0 else {
            unreachable!()
        };
        before_fields.insert(key("state"), string("VERIFY_RECORDED"));
        before_fields.insert(
            key("version"),
            Value(Node::Number(crate::legacy_json::Number::Integer(
                "7".into(),
            ))),
        );
        before_fields.insert(
            key("last_receipt_digest"),
            field(receipt, "verifiedReceiptDigest")?.deep_clone(),
        );
        need(
            equals(
                get(receipt, "beforeOperationDigest"),
                digest(&before)?.as_str(),
            ),
            HistoryError::Operation,
        )?;
        let original_profile = field(receipt, "profile")?;
        let profile = checked_profile(original_profile, op.request.employee_id.as_str())?;
        need(
            profile.version().get() == op.request.profile_version.get()
                && profile.binding().current_session().as_str()
                    == op.observation.data().current_sid.as_str()
                && profile.binding().target_session().as_str() == op.reserved_sid.as_str()
                && u64::from(profile.resources().memory_mib()) * reverie_core::operations::MIB
                    == op.request.requested_memory_bytes.get(),
            HistoryError::Profile,
        )?;
        // This field is still compared by Python equality at the next source
        // phase. Do not parse it prematurely into a digest-shaped string.
        let verified = field(receipt, "verifiedReceiptDigest")?.deep_clone();
        Ok(Self {
            receipt: value.deep_clone(),
            operation: operation.clone(),
            verified,
            profile_digest: digest(original_profile)?,
        })
    }
    pub fn assert_verified_and_plan(&self, metadata: &Metadata) -> Result<()> {
        let receipt = object(&self.receipt, HistoryError::Receipt)?;
        let verified = metadata.as_value();
        // The old source fingerprints even non-object data before accessing
        // its fields; all file I/O has already completed at this point.
        need(
            self.verified.python_eq(&string(digest(verified)?.as_str())),
            HistoryError::Verification,
        )?;
        let fields = object(verified, HistoryError::Verification)?;
        let op = self.operation.data();
        need(
            same(get(fields, "nativeFacts"), field(receipt, "nativeFacts")?)
                && equals(get(fields, "operationId"), op.id.as_str())
                && equals(get(fields, "reservationId"), op.reservation_id.as_str()),
            HistoryError::Verification,
        )?;
        self.assert_plan(receipt)
    }
    fn assert_plan(&self, receipt: &Object) -> Result<()> {
        let record = object(field(receipt, "planRecord")?, HistoryError::Plan)?;
        let intent = object(
            get(record, "resourceIntent").ok_or(HistoryError::Plan)?,
            HistoryError::Plan,
        )?;
        let op = self.operation.data();
        let literal_true = |name| matches!(get(record, name), Some(Value(Node::Bool(true))));
        let normal = object(field(receipt, "normalSession")?, HistoryError::Plan)?;
        need(
            equals(get(record, "id"), op.id.as_str())
                && equals(get(record, "employeeId"), op.request.employee_id.as_str())
                && equals(
                    get(record, "oldSession"),
                    op.observation.data().current_sid.as_str(),
                )
                && equals(get(record, "newSession"), op.reserved_sid.as_str())
                && equals(get(record, "phase"), "completed")
                && equals(get(record, "resourcePhase"), "verified")
                && literal_true("sourceStopRequested")
                && literal_true("sourceCleanupVerified")
                && equals(get(intent, "operationId"), op.id.as_str())
                && equals(get(intent, "reservationId"), op.reservation_id.as_str())
                && equals(get(intent, "profileDigest"), self.profile_digest.as_str())
                && equals(
                    get(normal, "recordDigest"),
                    digest(field(receipt, "planRecord")?)?.as_str(),
                ),
            HistoryError::Plan,
        )
    }
}
fn checked_profile(value: &Value, employee: &str) -> Result<ResourceProfile> {
    // Reuse the existing exact v1 profile validator through its document shape;
    // projected metadata has no duplicate raw keys to reinterpret here.
    let profiles = Value(Node::Object(
        [(key(employee), value.deep_clone())].into_iter().collect(),
    ));
    let document = Value(Node::Object(
        [
            (key("schema"), string(crate::profiles_v1::SCHEMA)),
            (
                key("revision"),
                Value(Node::Number(crate::legacy_json::Number::Integer(
                    "0".into(),
                ))),
            ),
            (key("profiles"), profiles),
        ]
        .into_iter()
        .collect(),
    ));
    let document = crate::profiles_v1::decode(&crate::worker_config::compact_data(&document))
        .map_err(HistoryError::ProfileData)?;
    let employee = ProfileEmployeeId::parse(employee).map_err(|_| HistoryError::Profile)?;
    document
        .profiles()
        .get(&employee)
        .cloned()
        .ok_or(HistoryError::Profile)
}
