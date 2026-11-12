//! Preserve only the actual known resume namespace and its settled digest
//! chains. No old receipt is spent as native closure or new resume authority.
use super::*;
use reverie_core::operations::{JournalDigest, JournalId};
use sha2::{Digest, Sha256};
use std::path::Path;

impl ActorSetupHistoryObservation {
    pub(super) fn resume_history(
        &mut self,
        snapshot: &mut Snapshot,
        root: &Path,
        purpose: &mut HistoryPurpose<'_>,
    ) -> HistoryResult<()> {
        let namespace = root.join("host-resume.namespace.json");
        let resume = root.join("host-resume");
        let present = |path: &Path| -> HistoryResult<bool> {
            match std::fs::symlink_metadata(path) {
                Ok(_) => Ok(true),
                Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(cause) => Err(GoalCustodyError::from(cause).into()),
            }
        };
        let directory_present = present(&resume)?;
        let anchor_present = present(&namespace)?;
        require(
            directory_present == anchor_present,
            "ACTOR_SETUP_RESUME_NAMESPACE",
        )?;
        if !directory_present {
            return Ok(());
        }
        let names = self.directory(snapshot, &resume)?;
        require(names.len() <= 256, "ACTOR_SETUP_RESUME_ACTIVE_OR_BOUND")?;
        let info = std::fs::symlink_metadata(&resume).map_err(GoalCustodyError::from)?;
        let raw = self.small_record(snapshot, &namespace)?;
        actor_setup_history::require_resume_namespace(
            &raw,
            [
                info.dev(),
                info.ino(),
                u64::from(info.uid()),
                u64::from(info.gid()),
            ],
        )?;
        let active = if names.contains("ACTIVE.json") {
            let raw = self.small_record(snapshot, &resume.join("ACTIVE.json"))?;
            let operation = actor_setup_history::RetainedExpiredResumeData::operation_id(&raw)?;
            require(
                names.contains(operation.as_str()),
                "ACTOR_SETUP_RESUME_OPERATION",
            )?;
            Some((operation, raw))
        } else {
            None
        };
        for name in names {
            if name == "ACTIVE.json" {
                continue;
            }
            let operation = JournalId::parse(&name)
                .map_err(|_| ActorSetupHistoryError::Refused("ACTOR_SETUP_RESUME_HISTORY_ENTRY"))?;
            if let Some((active_operation, raw)) = &active
                && active_operation == &operation
            {
                self.retain_expired_resume(snapshot, &resume.join(name), &operation, raw, purpose)?;
            } else {
                self.resume_operation(snapshot, &resume.join(name), &operation)?;
            }
        }
        Ok(())
    }
    fn resume_operation(
        &mut self,
        snapshot: &mut Snapshot,
        path: &Path,
        operation: &JournalId,
    ) -> HistoryResult<()> {
        let names = self.directory(snapshot, path)?;
        for name in &names {
            require(
                ["PLAN.json", "ATTEMPT.json", "RESULT.json", "COMPLETE.json"]
                    .contains(&name.as_str())
                    || name == "operation.lock"
                    || step_name(name),
                "ACTOR_SETUP_RESUME_HISTORY_ENTRY",
            )?;
        }
        self.resume_operation_lock(snapshot, path, &names)?;
        let attempted = names.contains("ATTEMPT.json");
        if !attempted {
            read::exact_names(&names, &[], &["PLAN.json", "operation.lock"])?;
            if names.contains("PLAN.json") {
                self.payload_record(snapshot, &path.join("PLAN.json"))?;
            }
            return Ok(());
        }
        require(
            ["PLAN.json", "RESULT.json", "COMPLETE.json"]
                .iter()
                .all(|name| names.contains(*name)),
            "ACTOR_SETUP_RESUME_UNKNOWN_BATCH_RETAINED",
        )?;
        let plan = self.payload_record(snapshot, &path.join("PLAN.json"))?;
        let result = self.payload_record(snapshot, &path.join("RESULT.json"))?;
        let complete = self.small_record(snapshot, &path.join("COMPLETE.json"))?;
        actor_setup_history::require_resume_complete(
            &complete,
            operation,
            &digest(&plan),
            &digest(&result),
        )?;
        for name in names {
            if [
                "PLAN.json",
                "RESULT.json",
                "COMPLETE.json",
                "operation.lock",
            ]
            .contains(&name.as_str())
            {
                continue;
            }
            self.payload_record(snapshot, &path.join(name))?;
        }
        Ok(())
    }
}
pub(super) fn step_name(name: &str) -> bool {
    ["STEP-", "ACK-"].iter().any(|prefix| {
        let Some(value) = name
            .strip_prefix(prefix)
            .and_then(|value| value.strip_suffix(".json"))
        else {
            return false;
        };
        !value.is_empty()
            && value.bytes().all(|value| value.is_ascii_digit())
            && (value == "0" || !value.starts_with('0'))
            && value.parse::<u32>().is_ok_and(|value| value < 256)
    })
}
fn digest(raw: &[u8]) -> JournalDigest {
    let raw = Sha256::digest(raw);
    let hex: String = raw.iter().map(|byte| format!("{byte:02x}")).collect();
    JournalDigest::parse(&hex).expect("actual SHA256")
}
