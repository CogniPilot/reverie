//! Strict newly-started identity DATA, sharing the recovery/limits row owner.
use super::*;
use crate::legacy_json::Number;
use reverie_core::ids::ContainerId;

impl RecoveryInspection {
    /// Does not mint a started phase: the host must supply its actual start owner.
    pub fn started_memory_pid(
        &self,
        name: &str,
        deployment: &str,
        session: &ProfileSessionId,
        expected: &ContainerId,
        policy: &WorkerPolicyDigest,
    ) -> Result<u32> {
        self.assert_memory_namespace(deployment, session)?;
        self.assert_memory_policy(policy)?;
        let equals = |key, expected: &str| -> Result<bool> {
            Ok(
                matches!(field(&self.value, key)?, Some(Value(Node::String(text))) if text.equals_ascii(expected)),
            )
        };
        if !self.running
            || name != format!("{deployment}-agent-{session}")
            || !equals("Name", &format!("/{name}"))?
            || !equals("Id", expected.as_str())?
        {
            return Err(RecoveryDataError::MemoryTarget);
        }
        let state = field(&self.value, "State")?.ok_or(RecoveryDataError::MemoryTarget)?;
        let Some(Value(Node::Number(Number::Integer(pid)))) = field(state, "Pid")? else {
            return Err(RecoveryDataError::MemoryTarget);
        };
        pid.parse::<u32>()
            .ok()
            .filter(|pid| *pid > 0)
            .ok_or(RecoveryDataError::MemoryTarget)
    }
    /// Same complete engine observation, preserving Python JSON value equality
    /// and treating only the daemon's unordered Mounts rows as a multiset.
    pub fn same_memory_observation(&self, other: &Self) -> Result<bool> {
        self.same_mount_set_observation(other)
    }
    /// Same whole perf observation, except the daemon's unordered Mounts list.
    /// Every complete mount row and every other field remain in the comparison.
    pub fn same_perf_observation(&self, other: &Self) -> Result<bool> {
        self.same_mount_set_observation(other)
    }
    /// Compare complete native single-container inspections for the same exact
    /// CID. Only Mounts row order is immaterial; no fields or rows are removed.
    /// This is DATA comparison, not process, membership or lifecycle authority.
    pub fn same_container_inspection(
        expected: &ContainerId,
        before: &str,
        after: &str,
    ) -> Result<bool> {
        let decode = |raw| -> Result<Self> {
            let RecoveryInspectionNeed::Present(row) =
                Self::inspect_data(expected.as_str(), raw, "", 0)?
            else {
                return Err(RecoveryDataError::InspectionUnavailable);
            };
            Ok(row)
        };
        Self::same_container_rows(expected, decode(before)?, decode(after)?)
    }
    /// Object-shaped sibling for the controller's exact native HTTP inspect.
    /// Arrays are not accepted here; complete object data is retained.
    pub fn same_container_object_inspection(
        expected: &str,
        before: &[u8],
        after: &[u8],
    ) -> Result<bool> {
        let expected = ContainerId::parse(expected).map_err(|_| RecoveryDataError::MemoryTarget)?;
        let decode = |raw| -> Result<Self> {
            let value = legacy_json::decode_engine_inventory(raw)
                .map_err(|_| RecoveryDataError::InspectionUnavailable)?;
            let state = field(&value, "State")?.ok_or(RecoveryDataError::InspectionUnavailable)?;
            let Some(Value(Node::Bool(running))) = field(state, "Running")? else {
                return Err(RecoveryDataError::InspectionUnavailable);
            };
            Ok(Self {
                running: *running,
                value,
            })
        };
        Self::same_container_rows(&expected, decode(before)?, decode(after)?)
    }
    fn same_container_rows(expected: &ContainerId, before: Self, after: Self) -> Result<bool> {
        for row in [&before, &after] {
            if !matches!(field(&row.value, "Id")?, Some(Value(Node::String(id))) if id.equals_ascii(expected.as_str()))
            {
                return Err(RecoveryDataError::MemoryTarget);
            }
        }
        before.same_mount_set_observation(&after)
    }
    fn same_mount_set_observation(&self, other: &Self) -> Result<bool> {
        let canonical = |original: &Value| -> Result<Value> {
            let mut value = original.deep_clone();
            let Node::Object(fields) = &mut value.0 else {
                return Err(RecoveryDataError::InspectionUnavailable);
            };
            let Some(Value(Node::Array(mounts))) = fields.get_mut(&key("Mounts")) else {
                return Err(RecoveryDataError::InspectionUnavailable);
            };
            *mounts = crate::worker_cold_tmp::canonical_mount_rows(mounts);
            Ok(value)
        };
        Ok(canonical(&self.value)?.python_eq(&canonical(&other.value)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value as Json, json};
    fn fixture() -> (Json, ProfileSessionId, ContainerId, WorkerPolicyDigest) {
        let session = ProfileSessionId::parse("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee").unwrap();
        let cid = ContainerId::parse(&"c".repeat(64)).unwrap();
        let config = crate::worker_config::decode(b"{}").unwrap();
        let policy = crate::worker_config::policy_digest(&config);
        let row = json!([{"Id":cid.as_str(),"Name":format!("/fixture-agent-{session}"),"State":{"Running":true,"Pid":321},"Config":{"Labels":{"reverie.worker":"fixture","reverie.session":session.as_str(),"reverie.worker-policy":policy.to_hex()}},"HostConfig":{"Memory":2147483648_u64},"Mounts":[]}]);
        (row, session, cid, policy)
    }
    fn decode(value: &Json) -> RecoveryInspection {
        let RecoveryInspectionNeed::Present(row) =
            RecoveryInspection::inspect_data("fixture", &value.to_string(), "", 0).unwrap()
        else {
            panic!("present");
        };
        row
    }
    #[test]
    fn strict_started_memory_fields_refuse_each_identity_mutation() {
        let (value, session, cid, policy) = fixture();
        let name = format!("fixture-agent-{session}");
        assert_eq!(
            decode(&value)
                .started_memory_pid(&name, "fixture", &session, &cid, &policy)
                .unwrap(),
            321
        );
        for (path, replacement) in [
            ("/0/Id", json!("f".repeat(64))),
            ("/0/Id", json!("c".repeat(63))),
            ("/0/Name", json!("/wrong")),
            ("/0/State/Running", json!(1)),
            ("/0/State/Running", json!(false)),
            ("/0/State/Pid", json!(true)),
            ("/0/State/Pid", json!(321.0)),
            ("/0/State/Pid", json!(0)),
            ("/0/State/Pid", json!(-1)),
            ("/0/State/Pid", json!(4294967296_u64)),
            ("/0/Config/Labels/reverie.worker", json!("other")),
            (
                "/0/Config/Labels/reverie.session",
                json!("00000000-0000-0000-0000-000000000000"),
            ),
            (
                "/0/Config/Labels/reverie.worker-policy",
                json!("0".repeat(64)),
            ),
        ] {
            let mut changed = value.clone();
            *changed.pointer_mut(path).unwrap() = replacement;
            let raw = RecoveryInspection::inspect_data(&name, &changed.to_string(), "", 0);
            let refused = match raw {
                Err(_) | Ok(RecoveryInspectionNeed::ConfirmAbsence) => true,
                Ok(RecoveryInspectionNeed::Present(row)) => row
                    .started_memory_pid(&name, "fixture", &session, &cid, &policy)
                    .is_err(),
            };
            assert!(refused, "{path}");
        }
        assert!(
            decode(&value)
                .started_memory_pid("wrong-agent", "fixture", &session, &cid, &policy)
                .is_err()
        );
    }
    #[test]
    fn complete_engine_equality_keeps_unknown_fields_and_python_numeric_semantics() {
        let (value, _, _, _) = fixture();
        let row = decode(&value);
        assert!(row.same_memory_observation(&decode(&value)).unwrap());
        let mut changed = value.clone();
        changed[0]["Extra"] = json!({"arbitrary":"field"});
        assert!(!row.same_memory_observation(&decode(&changed)).unwrap());
        let mut changed = value;
        changed[0]["HostConfig"]["Memory"] = json!(2147483648.0);
        assert!(row.same_memory_observation(&decode(&changed)).unwrap());
    }
}
