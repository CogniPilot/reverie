//! Terminal DATA only. The native owning coordinator alone may emit this
//! after actual publication and checked terminal release.
use super::*;
use crate::worker_pool::WorkerPoolPolicy;
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};

impl FleetMaintenanceRequest {
    pub fn migration_result(
        &self,
        policy: &WorkerPoolPolicy,
        configuration: &str,
        domain: &str,
        restore: &[(ProfileEmployeeId, ProfileSessionId)],
    ) -> Result<HumanFrame> {
        need(
            self.action == FleetMaintenanceAction::MigratePool,
            "POOL_MIGRATION_CONSENT_REQUIRED",
        )?;
        let configuration = JournalDigest::parse(configuration)
            .map_err(|_| ResourceActorDataError("POOL_MIGRATION_CONFIGURATION_DIGEST"))?;
        let domain = JournalDigest::parse(domain)
            .map_err(|_| ResourceActorDataError("POOL_MIGRATION_DOMAIN_DIGEST"))?;
        policy
            .validate()
            .map_err(|_| ResourceActorDataError("FLEET_PREVIEW_POLICY"))?;
        let raw = serde_json::to_vec(policy)
            .map_err(|_| ResourceActorDataError("FLEET_PREVIEW_POLICY"))?;
        let policy = HumanFrame::decode(&raw).map_err(frame_error)?;
        need(restore.len() <= 64, "POOL_MIGRATION_RESTORE_BOUND")?;
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
            (key("configurationDigest"), string(configuration.as_str())),
            (key("domainDigest"), string(domain.as_str())),
            (key("restore"), Value(Node::Array(rows))),
        ]);
        frame(Value(Node::Object(fields)))
    }
}
