//! Checked predecessor data for reopening the same physical pool. The native
//! owner must reobserve Docker and the retained directory before use.
use super::*;
use reverie_core::{decimal::UnsignedInteger, ids::ContainerId, operations::JournalDigest};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(try_from = "AnchorData", rename_all = "camelCase")]
pub struct RetainedPoolAnchor {
    container_id: String,
    original_birth_digest: String,
    pid: u32,
    process_start: String,
    parent_identity: [u64; 2],
    leaf_identity: [u64; 2],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AnchorData {
    container_id: String,
    original_birth_digest: String,
    pid: u32,
    process_start: String,
    parent_identity: [u64; 2],
    leaf_identity: [u64; 2],
}

impl RetainedPoolAnchor {
    pub fn from_observations(
        container: &ContainerId,
        birth: &JournalDigest,
        pid: u32,
        start: &str,
        parent: (u64, u64),
        leaf: (u64, u64),
    ) -> Result<Self, PoolPolicyError> {
        Self::try_from(AnchorData {
            container_id: container.as_str().to_owned(),
            original_birth_digest: birth.as_str().to_owned(),
            pid,
            process_start: start.to_owned(),
            parent_identity: parent.into(),
            leaf_identity: leaf.into(),
        })
    }

    pub fn container_id(&self) -> &str {
        &self.container_id
    }

    pub fn original_birth_digest(&self) -> &str {
        &self.original_birth_digest
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn matches_kernel(&self, start: &str, parent: (u64, u64), leaf: (u64, u64)) -> bool {
        self.process_start == start
            && self.parent_identity == <[u64; 2]>::from(parent)
            && self.leaf_identity == <[u64; 2]>::from(leaf)
    }
}

impl TryFrom<AnchorData> for RetainedPoolAnchor {
    type Error = PoolPolicyError;

    fn try_from(data: AnchorData) -> Result<Self, PoolPolicyError> {
        let start = UnsignedInteger::parse(&data.process_start);
        let valid = data.pid > 1
            && hex_id(&data.container_id)
            && JournalDigest::parse(&data.original_birth_digest).is_ok()
            && start.is_some_and(|start| {
                start.as_str() == data.process_start
                    && start.to_u64().is_some_and(|ticks| ticks > 0)
            })
            && data.parent_identity[0] == data.leaf_identity[0]
            && data.parent_identity[1] != 0
            && data.leaf_identity[1] != 0
            && data.parent_identity[1] != data.leaf_identity[1];
        if !valid {
            return Err(PoolPolicyError);
        }
        Ok(Self {
            container_id: data.container_id,
            original_birth_digest: data.original_birth_digest,
            pid: data.pid,
            process_start: data.process_start,
            parent_identity: data.parent_identity,
            leaf_identity: data.leaf_identity,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn retained_anchor_recovery_binds_process_and_both_cgroup_inodes() {
        let wire = json!({
            "containerId":"a".repeat(64),"originalBirthDigest":"b".repeat(64),
            "pid":430,"processStart":"70000","parentIdentity":[12,22],"leafIdentity":[12,27]
        });
        let anchor: RetainedPoolAnchor = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(&anchor).unwrap(), wire);
        assert!(anchor.matches_kernel("70000", (12, 22), (12, 27)));
        assert!(!anchor.matches_kernel("70001", (12, 22), (12, 27)));
        assert!(!anchor.matches_kernel("70000", (12, 23), (12, 27)));
        assert!(!anchor.matches_kernel("70000", (12, 22), (12, 28)));
        for (field, value) in [
            ("pid", json!(0)),
            ("containerId", json!("a".repeat(12))),
            ("originalBirthDigest", json!("B".repeat(64))),
            ("processStart", json!("070000")),
            ("leafIdentity", json!([12, 22])),
            ("leafIdentity", json!([13, 27])),
            ("newPath", json!("/sys/fs/cgroup")),
        ] {
            let mut changed = wire.clone();
            changed[field] = value;
            assert!(serde_json::from_value::<RetainedPoolAnchor>(changed).is_err());
        }
    }
}
