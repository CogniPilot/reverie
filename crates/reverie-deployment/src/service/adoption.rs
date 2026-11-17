//! Owner-selected metadata reconciliation. No Docker mutation is issued here.
use super::*;
use crate::adoption::{DeploymentPreviewMode, Selection};
use std::io::Read;
#[cfg(test)]
mod tests;

pub(super) fn birth(source: &Value) -> Result<String> {
    let pid = source["State"]["Pid"]
        .as_u64()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_ADOPTION_INIT_UNCONFIRMED"))?;
    let mut raw = String::new();
    std::fs::File::open(format!("/proc/{pid}/stat"))?
        .take(65537)
        .read_to_string(&mut raw)?;
    require(raw.len() <= 65536, "DEPLOYMENT_ADOPTION_INIT_UNCONFIRMED")?;
    reverie_contracts::kernel_accounting::process_start(&raw)
        .map_err(|_| DeploymentError::new("DEPLOYMENT_ADOPTION_INIT_UNCONFIRMED"))
}
fn same_incarnation(before: &Value, after: &Value) -> bool {
    model::projection(before) == model::projection(after)
        && before["Name"] == after["Name"]
        && before["NetworkSettings"] == after["NetworkSettings"]
        && [
            "Pid",
            "StartedAt",
            "Running",
            "Paused",
            "Restarting",
            "Dead",
        ]
        .iter()
        .all(|key| before["State"][key] == after["State"][key])
}
impl DeploymentService {
    /// Explicitly select a terminal predecessor whose exact old containers are
    /// gone. This records DATA only; prepare repeats the proof before handover.
    pub fn preview_adopting_stale_claim(
        &self,
        image: &str,
        profile: DeploymentProfile,
        mode: DeploymentPreviewMode,
        previous_id: &str,
        expected_current: &str,
    ) -> Result<DeploymentPreview> {
        model::image_id(image)?;
        model::cid(expected_current)?;
        let source = self.running_source()?;
        require(
            source["Id"] == expected_current,
            "DEPLOYMENT_ADOPTION_CURRENT_CHANGED",
        )?;
        let active = claim::selected(&self.installation)?;
        require(
            active == previous_id,
            "DEPLOYMENT_ADOPTION_PREDECESSOR_CHANGED",
        )?;
        let previous = self.operation(previous_id)?;
        let selection = Selection::capture(&previous, &source, birth(&source)?)?;
        let mut grants = PreviewGrants {
            adoption: Some(selection),
            ..Default::default()
        };
        if matches!(mode, DeploymentPreviewMode::Ordinary) {
            model::supported_profile(&source, profile)?;
        } else {
            let topology = crate::networks::Topology::capture(&source, &self.engine)?;
            model::supported_network_profile(&source, profile, &topology)?;
            grants.networks = Some(topology);
        }
        if matches!(mode, DeploymentPreviewMode::LiveAccountsFixForward) {
            let console = data_source_value(&source)?.join("console");
            grants.writers = Some(crate::live_accounts::Inventory::capture(
                &self.engine,
                &console,
                &[expected_current],
            )?);
        } else {
            self.refuse_shared_writers(&source)?;
        }
        let (body, refreshed) =
            self.profile_body_selection(&source, image, profile, grants.networks.as_ref())?;
        self.require_adoption_current(
            grants.adoption.as_ref().expect("selected above"),
            &source,
            false,
        )?;
        if let Some(topology) = &grants.networks {
            topology.require_current(&self.engine)?;
        }
        if let Some(writers) = &grants.writers {
            writers.require_current(&self.engine, &[expected_current])?;
        }
        self.record_preview(source, body, refreshed, profile, grants)
    }
    pub(super) fn require_adoption_current(
        &self,
        selection: &Selection,
        source: &Value,
        pending: bool,
    ) -> Result<()> {
        self.installation.current()?;
        selection.validate(source)?;
        let previous = self.operation(&selection.preview.previous_operation)?;
        selection.assert_previous(&previous, pending)?;
        self.engine
            .require_absent_container(&selection.preview.absent_source_selection)?;
        self.engine
            .require_absent_container(&selection.preview.absent_candidate_selection)?;
        let current = self.running_source()?;
        require(
            current["Name"] == format!("/{}", self.installation.name)
                && same_incarnation(&current, source)
                && current["State"]["Running"] == true
                && current["State"]["Paused"] == false
                && current["State"]["Restarting"] == false
                && current["State"]["Dead"] == false
                && birth(&current)? == selection.current_init_birth,
            "DEPLOYMENT_ADOPTION_CURRENT_CHANGED",
        )?;
        let image = self.engine.image(model::string(&current, "Image")?)?;
        require(
            image["Id"] == current["Image"],
            "DEPLOYMENT_ADOPTION_CURRENT_CHANGED",
        )?;
        let pins = crate::pins::Pins::capture(&current)?;
        let result = (|| {
            pins.running_mounts(&current)?;
            let id = model::string(&current, "Id")?;
            let front = model::uses_front(&current["Config"])?;
            self.process_tree(id, front)?;
            if !front {
                let top = self.engine.json(
                    "GET",
                    &format!("/containers/{id}/top?ps_args=-eo%20pid,ppid,comm"),
                    None,
                )?;
                require(
                    top["Processes"]
                        .as_array()
                        .is_some_and(|rows| rows.iter().any(|row| row[2] == "node")),
                    "DEPLOYMENT_ADOPTION_NODE_UNCONFIRMED",
                )?;
            }
            require(
                apply::status_responds_scoped(self.installation.port, OperationDeadline::Ordinary),
                "DEPLOYMENT_ADOPTION_HEALTH_UNCONFIRMED",
            )?;
            let after = self.running_source()?;
            require(
                same_incarnation(&after, &current)
                    && birth(&after)? == selection.current_init_birth,
                "DEPLOYMENT_ADOPTION_CURRENT_CHANGED",
            )?;
            pins.running_mounts(&after)
        })();
        DeploymentError::finalized(result, pins.close())
    }
}
