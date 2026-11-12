//! Migration reply DATA. Success requires actual publication and checked
//! terminal release; a failure diagnostic preserves an unconfirmed outcome.
use super::*;
use crate::worker_pool::WorkerPoolPolicy;
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};

impl FleetMaintenanceRequest {
    /// Diagnostic DATA only. An unconfirmed outcome never releases any native
    /// owner or authorizes replay, cleanup, admission or employee restoration.
    pub fn migration_failure(&self, code: &str) -> Result<HumanFrame> {
        need(
            self.action == FleetMaintenanceAction::MigratePool,
            "POOL_MIGRATION_CONSENT_REQUIRED",
        )?;
        need(
            (1..=96).contains(&code.len())
                && code.as_bytes()[0].is_ascii_uppercase()
                && code
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'),
            "POOL_MIGRATION_FAILURE_CODE",
        )?;
        let mut fields = envelope_fields("fleet-migration-failure", &self.request);
        fields.extend([
            (key("approval"), self.selected.approval_value()),
            (key("outcome"), string("unconfirmed")),
            (key("code"), string(code)),
        ]);
        frame(Value(Node::Object(fields)))
    }

    pub fn prepare_migration_result(
        &self,
        policy: &WorkerPoolPolicy,
        restore: &[(ProfileEmployeeId, ProfileSessionId)],
    ) -> Result<PreparedFleetMigrationReply> {
        need(
            self.action == FleetMaintenanceAction::MigratePool,
            "POOL_MIGRATION_CONSENT_REQUIRED",
        )?;
        policy
            .validate()
            .map_err(|_| ResourceActorDataError("FLEET_PREVIEW_POLICY"))?;
        let raw = serde_json::to_vec(policy)
            .map_err(|_| ResourceActorDataError("FLEET_PREVIEW_POLICY"))?;
        let policy =
            HumanFrame::decode_bounded(&raw, FLEET_REPLY_MAX_FRAME).map_err(frame_error)?;
        need(
            restore.len() <= crate::storage_identity::MAX_PROVIDER_EMPLOYEES,
            "POOL_MIGRATION_RESTORE_BOUND",
        )?;
        let mut employees = std::collections::BTreeSet::new();
        let mut sessions = std::collections::BTreeSet::new();
        let mut rows = Vec::new();
        for (employee, session) in restore {
            need(
                employees.insert(employee) && sessions.insert(session),
                "POOL_MIGRATION_RESTORE_AMBIGUOUS",
            )?;
            rows.push(Value(Node::Object(BTreeMap::from([
                (key("employeeId"), string(employee.as_str())),
                (key("sessionId"), string(session.as_str())),
            ]))));
        }
        let mut fields = envelope_fields("fleet-migration-result", &self.request);
        fields.extend([
            (key("approval"), self.selected.approval_value()),
            (key("phase"), string("pool-configured")),
            (key("policy"), policy.value().deep_clone()),
            (key("configurationDigest"), string(&"0".repeat(64))),
            (key("domainDigest"), string(&"0".repeat(64))),
            (key("restore"), Value(Node::Array(rows))),
        ]);
        PreparedFleetMigrationReply::prepare(Value(Node::Object(fields)))
    }
}
