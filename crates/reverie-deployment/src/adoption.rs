//! Explicit selection DATA for a terminal claim whose two old CIDs are absent.
//! No serialized field proves absence, present health or old data continuity.
use crate::{Result, installation, model, operation::Operation, require};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Clone, Copy)]
pub enum DeploymentPreviewMode {
    Ordinary,
    PreserveNetworks,
    LiveAccountsFixForward,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaimAdoptionPreview {
    pub previous_operation: String,
    pub expected_current_container: String,
    pub absent_source_selection: String,
    pub absent_candidate_selection: String,
    pub continuity_scope: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Selection {
    version: u32,
    pub(crate) preview: ClaimAdoptionPreview,
    plan_sha256: String,
    ready_sha256: String,
    candidate_sha256: String,
    pub(crate) current_init_birth: String,
    core: BTreeMap<String, Value>,
}
fn valid_id(text: &str, length: usize) -> bool {
    text.len() == length
        && text
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn core(source: &Value, declared: bool) -> Result<BTreeMap<String, Value>> {
    let rows = if declared {
        &source["HostConfig"]["Mounts"]
    } else {
        &source["Mounts"]
    };
    let rows = rows.as_array().ok_or_else(|| {
        crate::DeploymentError::new("DEPLOYMENT_ADOPTION_CORE_GRANTS_UNCONFIRMED")
    })?;
    let mut output = BTreeMap::new();
    for target in ["/instances/default", "/home/agent", "/reverie_workspace"] {
        let key = if declared { "Target" } else { "Destination" };
        let selected: Vec<_> = rows.iter().filter(|row| row[key] == target).collect();
        require(
            selected.len() == 1,
            "DEPLOYMENT_ADOPTION_CORE_GRANTS_UNCONFIRMED",
        )?;
        let row = selected[0];
        let source = PathBuf::from(model::string(row, "Source")?);
        require(
            row["Type"] == "bind" && source.is_absolute(),
            "DEPLOYMENT_ADOPTION_CORE_GRANTS_UNCONFIRMED",
        )?;
        let writable = if declared {
            row["ReadOnly"].as_bool().map(|ro| !ro)
        } else {
            row["RW"].as_bool()
        };
        require(
            writable == Some(true),
            "DEPLOYMENT_ADOPTION_CORE_GRANTS_UNCONFIRMED",
        )?;
        let propagation = if declared {
            &row["BindOptions"]["Propagation"]
        } else {
            &row["Propagation"]
        };
        require(
            propagation.is_null() || propagation == "" || propagation == "rprivate",
            "DEPLOYMENT_ADOPTION_CORE_GRANTS_UNCONFIRMED",
        )?;
        // These are declared names resolved NOW, never old inode/data proof.
        output.insert(target.into(), json!({"source":source.canonicalize()?,"type":"bind","rw":true,"propagation":"rprivate"}));
    }
    Ok(output)
}
fn digest(operation: &Operation, name: &str, maximum: u64) -> Result<String> {
    let path = operation.directory.join(name);
    installation::private(&path, false)?;
    Ok(installation::digest(&installation::read_bounded(
        &path, maximum,
    )?))
}
impl Selection {
    pub(crate) fn capture(previous: &Operation, current: &Value, birth: String) -> Result<Self> {
        previous.stale_ready(false)?;
        let source = model::cid(model::string(&previous.plan.source, "Id")?)?.to_owned();
        let candidate = previous.candidate()?;
        let selected = model::cid(model::string(current, "Id")?)?.to_owned();
        require(
            source != candidate && selected != source && selected != candidate,
            "DEPLOYMENT_ADOPTION_CURRENT_CHANGED",
        )?;
        let core = core(current, false)?;
        require(
            core == self::core(&previous.plan.source, false)?
                && core == self::core(&previous.plan.body, true)?,
            "DEPLOYMENT_ADOPTION_CORE_GRANTS_CHANGED",
        )?;
        let selection = Self {
            version: 1,
            preview: ClaimAdoptionPreview {
                previous_operation: previous.plan.operation.clone(),
                expected_current_container: selected,
                absent_source_selection: source,
                absent_candidate_selection: candidate,
                continuity_scope:
                    "declared-core-bindings-only; old inode and data continuity unproven".into(),
            },
            plan_sha256: digest(previous, "plan.json", 16 * 1024 * 1024)?,
            ready_sha256: digest(previous, "ready.json", 65536)?,
            candidate_sha256: digest(previous, "candidate.json", 65536)?,
            current_init_birth: birth,
            core,
        };
        selection.validate(current)?;
        Ok(selection)
    }
    pub(crate) fn validate(&self, source: &Value) -> Result<()> {
        require(
            self.version == 1
                && valid_id(&self.preview.previous_operation, 32)
                && valid_id(&self.preview.expected_current_container, 64)
                && valid_id(&self.preview.absent_source_selection, 64)
                && valid_id(&self.preview.absent_candidate_selection, 64)
                && self.preview.absent_source_selection != self.preview.absent_candidate_selection
                && self.preview.expected_current_container != self.preview.absent_source_selection
                && self.preview.expected_current_container
                    != self.preview.absent_candidate_selection
                && self.preview.expected_current_container == source["Id"]
                && self.preview.continuity_scope
                    == "declared-core-bindings-only; old inode and data continuity unproven"
                && valid_id(&self.plan_sha256, 64)
                && valid_id(&self.ready_sha256, 64)
                && valid_id(&self.candidate_sha256, 64)
                && !self.current_init_birth.is_empty()
                && self.current_init_birth.len() <= 20
                && self.current_init_birth.bytes().all(|b| b.is_ascii_digit()),
            "DEPLOYMENT_ADOPTION_SELECTION_INVALID",
        )?;
        require(
            self.core == core(source, false)?,
            "DEPLOYMENT_ADOPTION_CORE_GRANTS_CHANGED",
        )
    }
    pub(crate) fn assert_previous(&self, previous: &Operation, pending: bool) -> Result<()> {
        previous.stale_ready(pending)?;
        require(
            previous.plan.operation == self.preview.previous_operation
                && previous.plan.source["Id"] == self.preview.absent_source_selection
                && previous.candidate()? == self.preview.absent_candidate_selection
                && digest(previous, "plan.json", 16 * 1024 * 1024)? == self.plan_sha256
                && digest(previous, "ready.json", 65536)? == self.ready_sha256
                && digest(previous, "candidate.json", 65536)? == self.candidate_sha256,
            "DEPLOYMENT_ADOPTION_PREDECESSOR_CHANGED",
        )?;
        require(
            self.core == core(&previous.plan.source, false)?
                && self.core == core(&previous.plan.body, true)?,
            "DEPLOYMENT_ADOPTION_CORE_GRANTS_CHANGED",
        )
    }
}
