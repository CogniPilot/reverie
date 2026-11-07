//! Original unprotected stop fence under the same real allocation admission.
//! Passing this check supplies no process ownership or permission to stop.
use super::*;
use std::collections::BTreeSet;

impl Inner {
    pub(super) fn check_ordinary_stop(self: &Arc<Self>, target: &str) -> Result<()> {
        // Preserve check_stop's order even if the requested name is already
        // protected: native guard FIRST, then canonical document/history and
        // the complete selected identity inventory, before the final refusal.
        let rows = self.guard(None)?;
        let operations = self.active_operations(&self.document()?)?;
        let sessions = operations
            .iter()
            .flat_map(|operation| {
                let data = operation.data();
                [
                    data.observation.data().current_sid.as_str(),
                    data.reserved_sid.as_str(),
                ]
            })
            .collect::<BTreeSet<_>>();
        let deployment = self.config()?.deployment()?;
        let names = sessions
            .iter()
            .map(|session| format!("{deployment}-agent-{session}"))
            .collect::<BTreeSet<_>>();
        let mut identities = BTreeSet::new();
        for row in rows.rows() {
            let row = row.data();
            if row.label_is("reverie.worker", &deployment)?
                && row.reservation_stop_session_in(&sessions)?
            {
                identities.insert(row.id().as_str().to_owned());
            }
        }
        need(
            !names.contains(target) && !identities.contains(target),
            "RESOURCE_OPERATION_STOP_REQUIRES_PROTECTED_RECONCILIATION",
        )
    }
}
