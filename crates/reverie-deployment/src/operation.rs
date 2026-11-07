use super::*;
use crate::installation::{exclusive_json, private, read_bounded};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
pub(super) struct Plan {
    pub(super) version: u32,
    pub(super) operation: String,
    pub(super) container: String,
    pub(super) installation_revision: String,
    pub(super) source: Value,
    pub(super) body: Value,
    pub(super) preview: DeploymentPreview,
    pub(super) bind_identities: Vec<crate::pins::Identity>,
}
pub(super) struct Operation {
    pub(super) directory: PathBuf,
    pub(super) plan: Plan,
}
impl Operation {
    pub(super) fn create(state: &Path, plan: Plan) -> Result<Self> {
        let parent = state.join("console-deployments");
        std::fs::DirBuilder::new()
            .mode(0o700)
            .recursive(true)
            .create(&parent)?;
        private(&parent, true)?;
        let directory = parent.join(&plan.operation);
        std::fs::DirBuilder::new().mode(0o700).create(&directory)?;
        exclusive_json(&directory.join("plan.json"), &serde_json::to_value(&plan)?)?;
        Ok(Self { directory, plan })
    }
    pub(super) fn open(state: &Path, id: &str) -> Result<Self> {
        require(
            id.len() == 32
                && id
                    .bytes()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "DEPLOYMENT_OPERATION_INVALID",
        )?;
        let directory = state.join("console-deployments").join(id);
        private(&directory, true)?;
        private(&directory.join("plan.json"), false)?;
        let plan: Plan = serde_json::from_slice(&read_bounded(
            &directory.join("plan.json"),
            16 * 1024 * 1024,
        )?)?;
        require(
            plan.version == 1 && plan.operation == id,
            "DEPLOYMENT_OPERATION_INVALID",
        )?;
        Ok(Self { directory, plan })
    }
    pub(super) fn record(&self, name: &str, data: &Value) -> Result<()> {
        exclusive_json(
            &self.directory.join(format!("{name}.json")),
            &json!({
            "schema":"reverie-console-deployment-receipt-v1","operation":self.plan.operation,"phase":name,"data":data}),
        )
    }
    fn read_record(&self, name: &str) -> Result<Value> {
        let path = self.directory.join(format!("{name}.json"));
        private(&path, false)?;
        let value: Value = serde_json::from_slice(&read_bounded(&path, 64 * 1024)?)?;
        require(
            value["schema"] == "reverie-console-deployment-receipt-v1"
                && value["operation"] == self.plan.operation
                && value["phase"] == name
                && value["data"].is_object(),
            "DEPLOYMENT_RECEIPT_UNCONFIRMED",
        )?;
        Ok(value["data"].clone())
    }
    pub(super) fn exists(&self, name: &str) -> bool {
        self.directory.join(format!("{name}.json")).exists()
    }
    pub(super) fn candidate(&self) -> Result<String> {
        let value = self.read_record("candidate")?;
        Ok(model::cid(model::string(&value, "id")?)?.to_owned())
    }
    pub(super) fn prepared(&self) -> Result<()> {
        let value = self.read_record("prepared")?;
        require(
            value["validated"] == true && value["candidateId"] == self.candidate()?,
            "DEPLOYMENT_CANDIDATE_UNVALIDATED",
        )
    }
    pub(super) fn status(&self) -> Result<DeploymentStatus> {
        let mut stage = "PREVIEW";
        for (file, value) in [
            ("create-attempt", "CREATE_UNCONFIRMED"),
            ("candidate", "CANDIDATE_UNVALIDATED"),
            ("prepared", "PREPARED"),
            ("stop-attempt", "STOP_UNCONFIRMED"),
            ("snapshot", "SNAPSHOT_VERIFIED"),
            ("old-rename-attempt", "SWAP_UNCONFIRMED"),
            ("start-attempt", "START_UNCONFIRMED"),
            ("ready", "HYBRID_READY"),
            ("rollback-attempt", "ROLLBACK_UNCONFIRMED"),
            ("restored", "RESTORED"),
        ] {
            if !self.exists(file) {
                continue;
            }
            let valid = self.receipt_valid(file);
            stage = if valid { value } else { "RECEIPT_UNCONFIRMED" };
        }
        Ok(DeploymentStatus {
            operation: self.plan.operation.clone(),
            stage: stage.into(),
            candidate_id: if self.exists("candidate") {
                Some(self.candidate()?)
            } else {
                None
            },
            source_id: model::string(&self.plan.source, "Id")?.to_owned(),
            backup_verified: if self.exists("unverified-backup-accepted") {
                Some(false)
            } else if self.exists("snapshot") && self.receipt_valid("snapshot") {
                Some(true)
            } else {
                None
            },
        })
    }
    fn receipt_valid(&self, file: &str) -> bool {
        match file {
            "prepared" => self.prepared().is_ok(),
            "snapshot" => self
                .read_record(file)
                .is_ok_and(|r| r["sha256"].as_str().is_some_and(|s| s.len() == 64)),
            "ready" => self.read_record(file).is_ok_and(|r| {
                r["mode"] == "hybrid-rust-front"
                    && r["containerId"] == self.candidate().unwrap_or_default()
                    && r["brokerChanged"] == false
            }),
            "restored" => self.read_record(file).is_ok_and(|r| {
                r["containerId"] == self.plan.source["Id"]
                    && r["dataRestored"] == false
                    && r["brokerChanged"] == false
            }),
            _ => true,
        }
    }
    pub(super) fn attempt(&self, phase: &str) -> Result<()> {
        self.record(phase, &json!({"state":"ATTEMPT_NO_AUTOMATIC_RETRY"}))
    }
}
