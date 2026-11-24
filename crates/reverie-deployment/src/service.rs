use super::*;
use crate::{
    engine::Engine,
    installation::Installation,
    operation::{Operation, Plan},
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
mod adoption;
mod apply;
mod claim;
mod invalid_create;
mod rollback;
mod scratch;
mod shared_writers;
use apply::OperationDeadline;

#[derive(Default)]
struct PreviewGrants {
    networks: Option<crate::networks::Topology>,
    writers: Option<crate::live_accounts::Inventory>,
    adoption: Option<crate::adoption::Selection>,
}

/// Local host-owner bootstrap service over the registered deployment. The
/// installed owner executes this API; guests and role names confer no access.
pub struct DeploymentService {
    installation: Installation,
    engine: Engine,
}
impl DeploymentService {
    /// Reobserve the exact already-ready protected deployment, without any
    /// preparation/apply call. The held update lock protects these reads.
    pub(crate) fn actor_recovery_status(
        &self,
        id: &str,
        image: &str,
        end: Instant,
    ) -> Result<DeploymentStatus> {
        let operation = self.operation(id)?;
        require(
            operation.plan.profile() == DeploymentProfile::ProtectedWebsite
                && operation.plan.preview.candidate_image == image,
            "DEPLOYMENT_ACTOR_RECOVERY_SELECTION_CHANGED",
        )?;
        let status = self.status_before(id, end)?;
        require(
            status.stage == "HYBRID_READY",
            "DEPLOYMENT_ACTOR_RECOVERY_NOT_READY",
        )?;
        let (candidate, _) = operation.readiness_target(true)?;
        let current = self.engine.container(&self.installation.name)?;
        require(
            current["Id"] == candidate && current["Image"] == image,
            "DEPLOYMENT_ACTOR_RECOVERY_SELECTION_CHANGED",
        )?;
        Ok(status)
    }
    pub(crate) fn restrict_initial_website(&mut self, end: Instant) -> Result<()> {
        self.engine.restrict_initial_website(end)
    }
    pub(crate) fn registered_container_name(&self) -> &str {
        &self.installation.name
    }
    pub(crate) fn initial_actor_image(&self, image: &str) -> Result<Value> {
        model::image_id(image)?;
        self.engine.image(image)
    }
    /// Read-only compatibility before the whole initial owner quiesces any
    /// worker. This is not a preview OP, writer exclusion or deployment grant.
    pub(crate) fn check_initial_website_selection(&self, image: &str) -> Result<()> {
        model::image_id(image)?;
        let source = self.profile_source(model::DeploymentProfile::ProtectedWebsite)?;
        self.profile_body(&source, image, model::DeploymentProfile::ProtectedWebsite)?;
        let pins = crate::pins::Pins::capture(&source)?;
        let result = pins.running_mounts(&source);
        DeploymentError::finalized(result, pins.close())
    }
    fn profile_source(&self, profile: model::DeploymentProfile) -> Result<Value> {
        let source = self.running_source()?;
        model::supported_profile(&source, profile)?;
        Ok(source)
    }
    fn running_source(&self) -> Result<Value> {
        self.installation.current()?;
        let source = self.engine.container(&self.installation.name)?;
        model::port_binding(&source, self.installation.port)?;
        require(
            source["State"]["Running"] == true,
            "DEPLOYMENT_SOURCE_NOT_RUNNING",
        )?;
        Ok(source)
    }
    fn profile_body(
        &self,
        source: &Value,
        image: &str,
        profile: model::DeploymentProfile,
    ) -> Result<(Value, Vec<String>)> {
        self.profile_body_selection(source, image, profile, None)
    }
    fn profile_body_selection(
        &self,
        source: &Value,
        image: &str,
        profile: model::DeploymentProfile,
        topology: Option<&crate::networks::Topology>,
    ) -> Result<(Value, Vec<String>)> {
        let old_image = self.engine.image(model::string(source, "Image")?)?;
        let candidate = self.engine.image(image)?;
        require(
            candidate["Id"] == image,
            "DEPLOYMENT_CANDIDATE_IMAGE_CHANGED",
        )?;
        match topology {
            Some(topology) => model::create_body_selection(
                source,
                &old_image,
                &candidate,
                profile,
                Some(topology),
            ),
            None => model::create_body_profile(source, &old_image, &candidate, profile),
        }
    }
    pub fn close(&mut self) -> Result<()> {
        self.installation.close()
    }
    pub fn capture(root: &Path) -> Result<Self> {
        Self::capture_with(root, || Engine::new(Path::new("/var/run/docker.sock")))
    }
    /// Read the registered journal during Engine outages. Terminal readiness
    /// still requires a fresh authenticated Engine observation.
    pub fn registered_status(root: &Path, id: &str) -> Result<DeploymentStatus> {
        Self::registered_status_with_socket(root, Some(id), Path::new("/var/run/docker.sock"))
    }
    /// Inspect the operation holding the installation claim under the same update lock.
    pub fn registered_active_status(root: &Path) -> Result<DeploymentStatus> {
        Self::registered_status_with_socket(root, None, Path::new("/var/run/docker.sock"))
    }
    fn registered_status_with_socket(
        root: &Path,
        id: Option<&str>,
        socket: &Path,
    ) -> Result<DeploymentStatus> {
        let mut service = Self::capture_with(root, || Engine::client(socket))?;
        let status = match id {
            Some(id) => service.status(id),
            None => claim::active_status(&service),
        };
        DeploymentError::finalized(status, service.close())
    }
    fn capture_with(root: &Path, connect: impl FnOnce() -> Result<Engine>) -> Result<Self> {
        let mut installation = Installation::capture(root)?;
        let engine = match connect() {
            Ok(engine) => engine,
            Err(error) => return DeploymentError::finalized(Err(error), installation.close()),
        };
        Ok(Self {
            installation,
            engine,
        })
    }
    /// Freeze a release preview without changing a container or company data.
    pub fn preview(&self, image: &str) -> Result<DeploymentPreview> {
        self.preview_with_profile(image, model::DeploymentProfile::Ordinary)
    }
    /// Explicit protected settings affect only the website candidate. Shared
    /// writer exclusion, exact real bind grants and verified backup still apply.
    pub fn preview_with_profile(
        &self,
        image: &str,
        profile: model::DeploymentProfile,
    ) -> Result<DeploymentPreview> {
        model::image_id(image)?;
        let source = self.profile_source(profile)?;
        self.refuse_shared_writers(&source)?;
        let (body, refreshed_environment_keys) = self.profile_body(&source, image, profile)?;
        self.record_preview(
            source,
            body,
            refreshed_environment_keys,
            profile,
            PreviewGrants::default(),
        )
    }
    /// Preserve only the observed original dynamic bridge network grants.
    /// Verified backup and the existing shared-writer refusal still apply.
    pub fn preview_preserving_networks(
        &self,
        image: &str,
        profile: model::DeploymentProfile,
    ) -> Result<DeploymentPreview> {
        model::image_id(image)?;
        let source = self.running_source()?;
        let topology = crate::networks::Topology::capture(&source, &self.engine)?;
        model::supported_network_profile(&source, profile, &topology)?;
        self.refuse_shared_writers(&source)?;
        let (body, refreshed) =
            self.profile_body_selection(&source, image, profile, Some(&topology))?;
        topology.require_current(&self.engine)?;
        self.record_preview(
            source,
            body,
            refreshed,
            profile,
            PreviewGrants {
                networks: Some(topology),
                ..Default::default()
            },
        )
    }
    /// Explicit fix-forward disposition for exact independently live account
    /// directory writers. This never certifies a consistent backup or rollback.
    pub fn preview_live_accounts_fix_forward(
        &self,
        image: &str,
        profile: model::DeploymentProfile,
    ) -> Result<DeploymentPreview> {
        model::image_id(image)?;
        let source = self.running_source()?;
        let topology = crate::networks::Topology::capture(&source, &self.engine)?;
        model::supported_network_profile(&source, profile, &topology)?;
        let console = data_source_value(&source)?.join("console");
        let selected = model::string(&source, "Id")?;
        let writers =
            crate::live_accounts::Inventory::capture(&self.engine, &console, &[selected])?;
        writers.validate(&console)?;
        let (body, refreshed) =
            self.profile_body_selection(&source, image, profile, Some(&topology))?;
        topology.require_current(&self.engine)?;
        writers.require_current(&self.engine, &[selected])?;
        self.record_preview(
            source,
            body,
            refreshed,
            profile,
            PreviewGrants {
                networks: Some(topology),
                writers: Some(writers),
                adoption: None,
            },
        )
    }
    fn record_preview(
        &self,
        source: Value,
        mut body: Value,
        mut refreshed_environment_keys: Vec<String>,
        profile: model::DeploymentProfile,
        grants: PreviewGrants,
    ) -> Result<DeploymentPreview> {
        model::preserve_private_access(&source, &mut body, &mut refreshed_environment_keys)?;
        let PreviewGrants {
            networks: network_topology,
            writers: live_account_writers,
            adoption: claim_adoption,
        } = grants;
        let pins = crate::pins::Pins::capture(&source)?;
        if let Err(error) = pins.running_mounts(&source) {
            return DeploymentError::finalized(Err(error), pins.close());
        }
        let bind_identities = pins.identities();
        let result = (|| {
            let operation = new_id()?;
            let preview = DeploymentPreview {
            claim_adoption: claim_adoption.as_ref().map(|selected|selected.preview.clone()),
            operation: operation.clone(),
            container: self.installation.name.clone(),
            source_id: model::string(&source, "Id")?.into(),
            source_image: model::string(&source, "Image")?.into(),
            candidate_image: model::string(&body, "Image")?.into(),
            environment_policy: "refresh-image-defaults-preserve-overrides-and-private-access".into(),
            refreshed_environment_keys,
            broker_preserved: true,
            backup_metadata_scope:"console bytes and caller-visible metadata/ACLs/xattrs; no automatic live data restore".into(),
            profile: profile.preview(),
            preserved_networks: network_topology.as_ref().map(crate::networks::Topology::preview),
            live_accounts: live_account_writers.as_ref().map(crate::live_accounts::Inventory::preview),
            stopped_backup: live_account_writers.is_none().then(|| self.stopped_backup(&source)),
        };
            let plan = Plan {
                version: if claim_adoption.is_some() {
                    6
                } else if live_account_writers.is_some() {
                    5
                } else if network_topology.is_some() {
                    4
                } else {
                    profile.version()
                },
                operation,
                container: self.installation.name.clone(),
                installation_revision: self.installation.revision.clone(),
                source,
                body,
                preview: serde_json::from_value(serde_json::to_value(&preview)?)?,
                bind_identities,
                network_topology,
                live_account_writers,
                claim_adoption,
            };
            Operation::create(&self.installation.state, plan)?;
            Ok(preview)
        })();
        DeploymentError::finalized(result, pins.close())
    }
    /// Create a checked sleeping candidate. Ports bind only when it is started.
    /// An uncertain create is never resubmitted automatically.
    pub fn prepare(&self, id: &str) -> Result<DeploymentStatus> {
        self.prepare_scoped(id, OperationDeadline::Ordinary)
    }
    pub(crate) fn prepare_before(&self, id: &str, end: Instant) -> Result<DeploymentStatus> {
        self.prepare_scoped(id, OperationDeadline::Initial(end))
    }
    fn prepare_scoped(&self, id: &str, deadline: OperationDeadline) -> Result<DeploymentStatus> {
        deadline.check()?;
        let operation = self.effect_operation(id)?;
        self.source_current(&operation, true)?;
        let pins = self.pins(&operation)?;
        let result = self.prepare_pinned(&operation, &pins, deadline);
        DeploymentError::finalized(result, pins.close())
    }
    fn prepare_pinned(
        &self,
        operation: &Operation,
        pins: &crate::pins::Pins,
        deadline: OperationDeadline,
    ) -> Result<DeploymentStatus> {
        require(
            !operation.exists("create-attempt"),
            "DEPLOYMENT_CREATE_ALREADY_ATTEMPTED",
        )?;
        let before = self.source_current(operation, true)?;
        let claim = self.claim(operation, &before)?;
        let current = self.source_current(operation, true)?;
        claim.finish(operation, &current)?;
        pins.running_mounts(&current)?;
        self.verify_effect_pins(operation, pins)?;
        operation.attempt("create-attempt")?;
        deadline.check()?;
        let name = temporary_name(operation, "candidate");
        let created = self.engine.json(
            "POST",
            &format!("/containers/create?name={name}"),
            Some(&operation.plan.body),
        )?;
        let candidate = model::cid(model::string(&created, "Id")?)?;
        operation.record("candidate", &json!({"id":candidate}))?;
        require(
            created["Warnings"].is_null()
                || created["Warnings"].as_array().is_some_and(Vec::is_empty),
            "DEPLOYMENT_CREATE_WARNING_REQUIRES_REVIEW",
        )?;
        let actual = self.engine.container(candidate)?;
        operation.plan.candidate_matches(&actual, &self.engine)?;
        require(
            actual["Name"] == format!("/{name}"),
            "DEPLOYMENT_CANDIDATE_NAME_CHANGED",
        )?;
        self.verify_effect_pins(operation, pins)?;
        operation.record(
            "prepared",
            &json!({"candidateId":candidate,"validated":true}),
        )?;
        operation.status()
    }
    /// Reinspect the recorded sleeping candidate without repeating creation.
    /// This explicit recovery action still checks the original running source.
    pub fn confirm(&self, id: &str) -> Result<DeploymentStatus> {
        let operation = self.effect_operation(id)?;
        self.claimed(&operation)?;
        self.source_current(&operation, true)?;
        let pins = self.pins(&operation)?;
        let result = (|| {
            let candidate = operation.candidate()?;
            let actual = self.engine.container(&candidate)?;
            operation.plan.candidate_matches(&actual, &self.engine)?;
            require(
                actual["Name"] == format!("/{}", temporary_name(&operation, "candidate"))
                    && actual["State"]["Running"] == false
                    && actual["State"]["Status"] == "created",
                "DEPLOYMENT_CANDIDATE_NOT_SLEEPING",
            )?;
            pins.running_mounts(&self.source_current(&operation, true)?)?;
            operation.record(
                "prepared",
                &json!({"candidateId":candidate,"validated":true}),
            )?;
            operation.status()
        })();
        DeploymentError::finalized(result, pins.close())
    }
    pub fn status(&self, id: &str) -> Result<DeploymentStatus> {
        self.status_scoped(id, OperationDeadline::Ordinary)
    }
    pub(crate) fn status_before(&self, id: &str, end: Instant) -> Result<DeploymentStatus> {
        self.status_scoped(id, OperationDeadline::Initial(end))
    }
    fn status_scoped(&self, id: &str, deadline: OperationDeadline) -> Result<DeploymentStatus> {
        deadline.check()?;
        let operation = self.operation(id)?;
        let mut status = operation.status()?;
        let observed = match status.stage.as_str() {
            "HYBRID_READY" => self.observe_ready(&operation, true, deadline),
            "RESTORED" => self.observe_ready(&operation, false, deadline),
            _ => Ok(()),
        };
        if let Err(error) = observed {
            status.readiness_failure = Some(model::ReadinessFailure {
                recorded_stage: std::mem::replace(
                    &mut status.stage,
                    "READINESS_UNCONFIRMED".into(),
                ),
                diagnostic: error.diagnostic(),
            });
        }
        deadline.check()?;
        Ok(status)
    }
    fn observe_ready(
        &self,
        operation: &Operation,
        candidate: bool,
        deadline: OperationDeadline,
    ) -> Result<()> {
        let (id, front) = operation.readiness_target(candidate)?;
        let pins = self.pins(operation)?;
        let result = (|| {
            let current = self.engine.container(&id)?;
            if candidate {
                operation.plan.candidate_matches(&current, &self.engine)?;
                self.source_current(operation, false)?;
            } else {
                self.original_source_selection(operation, &current)?;
            }
            require(
                current["State"]["Running"] == true
                    && current["Name"] == format!("/{}", operation.plan.container),
                "DEPLOYMENT_WEBSITE_EXITED",
            )?;
            model::port_binding(&current, self.installation.port)?;
            pins.running_mounts(&current)?;
            require(
                apply::status_responds_scoped(self.installation.port, deadline),
                "DEPLOYMENT_READINESS_UNCONFIRMED",
            )?;
            deadline.check()?;
            self.process_tree(&id, front)?;
            self.verify_observation_pins(operation, &pins)?;
            deadline.check()
        })();
        DeploymentError::finalized(result, pins.close())
    }
    fn operation(&self, id: &str) -> Result<Operation> {
        self.installation.current()?;
        let operation = Operation::open(&self.installation.state, id)?;
        require(
            operation.plan.container == self.installation.name
                && operation.plan.installation_revision == self.installation.revision,
            "DEPLOYMENT_SELECTION_CHANGED",
        )?;
        Ok(operation)
    }
    fn source_current(&self, operation: &Operation, running: bool) -> Result<Value> {
        self.installation.current()?;
        let id = model::cid(model::string(&operation.plan.source, "Id")?)?;
        let current = self.engine.container(id)?;
        self.original_source_selection(operation, &current)?;
        require(
            current["State"]["Running"] == running
                && current["State"]["Paused"] == false
                && current["State"]["Restarting"] == false
                && current["State"]["Dead"] == false,
            "DEPLOYMENT_SOURCE_STATE_CHANGED",
        )?;
        require(
            current["State"]["StartedAt"] == operation.plan.source["State"]["StartedAt"],
            "DEPLOYMENT_SOURCE_EPOCH_CHANGED",
        )?;
        if running {
            require(
                current["State"]["Pid"] == operation.plan.source["State"]["Pid"],
                "DEPLOYMENT_SOURCE_EPOCH_CHANGED",
            )?;
        }
        if !running {
            require(
                current["State"]["Pid"] == 0,
                "DEPLOYMENT_SOURCE_NOT_STOPPED",
            )?;
        }
        Ok(current)
    }
    fn verify_effect_pins(&self, operation: &Operation, pins: &crate::pins::Pins) -> Result<()> {
        self.verify_observation_pins(operation, pins)?;
        self.verify_live_account_writers(operation)
    }
    fn verify_observation_pins(
        &self,
        operation: &Operation,
        pins: &crate::pins::Pins,
    ) -> Result<()> {
        pins.verify()?;
        if let Some(topology) = &operation.plan.network_topology {
            topology.require_current(&self.engine)?;
        }
        Ok(())
    }
    fn verify_live_account_writers(&self, operation: &Operation) -> Result<()> {
        if let Some(writers) = &operation.plan.live_account_writers {
            let source = model::string(&operation.plan.source, "Id")?;
            let candidate = operation
                .exists("candidate")
                .then(|| operation.candidate())
                .transpose()?;
            let mut websites = vec![source];
            if let Some(candidate) = &candidate {
                websites.push(candidate.as_str());
            }
            writers.require_current(&self.engine, &websites)?;
        }
        Ok(())
    }
    fn original_source_selection(&self, operation: &Operation, current: &Value) -> Result<()> {
        operation.plan.source_matches(current)?;
        if let Some(topology) = &operation.plan.network_topology {
            topology.require_current(&self.engine)?;
        }
        Ok(())
    }
    fn claimed(&self, operation: &Operation) -> Result<()> {
        require(
            !operation.record_present("successor-attempt")?,
            "DEPLOYMENT_CLAIM_SUPERSEDED_OR_UNCONFIRMED",
        )?;
        let bytes = installation::read_bounded(
            &self
                .installation
                .state
                .join("console-deployment-active.json"),
            1024,
        )?;
        let value: Value = serde_json::from_slice(&bytes)?;
        require(
            value["operation"] == operation.plan.operation,
            "DEPLOYMENT_OTHER_OPERATION_ACTIVE",
        )
    }
    fn pins(&self, operation: &Operation) -> Result<crate::pins::Pins> {
        let pins = crate::pins::Pins::capture(&operation.plan.source)?;
        match pins.matches(&operation.plan.bind_identities) {
            Ok(()) => Ok(pins),
            Err(error) => DeploymentError::finalized(Err(error), pins.close()),
        }
    }
    fn data_source(&self, operation: &Operation) -> Result<PathBuf> {
        data_source_value(&operation.plan.source)
    }
}
pub(super) fn data_source_value(source: &Value) -> Result<PathBuf> {
    let mounts = source["Mounts"]
        .as_array()
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_MOUNTS_REQUIRED"))?;
    let selected = mounts
        .iter()
        .filter(|m| m["Destination"] == "/instances/default")
        .collect::<Vec<_>>();
    require(
        selected.len() == 1 && selected[0]["Type"] == "bind" && selected[0]["RW"] == true,
        "DEPLOYMENT_DATA_BIND_REQUIRED",
    )?;
    for entry in source["Config"]["Env"].as_array().into_iter().flatten() {
        let entry = entry
            .as_str()
            .ok_or_else(|| DeploymentError::new("DEPLOYMENT_ENV_INVALID"))?;
        require(
            !entry.starts_with("REVERIE_DATA=") || entry == "REVERIE_DATA=/instances/default",
            "DEPLOYMENT_DATA_LAYOUT_UNSUPPORTED",
        )?;
        require(
            !entry.starts_with("REVERIE_DATA_DIR=")
                || entry == "REVERIE_DATA_DIR=/instances/default/console",
            "DEPLOYMENT_DATA_LAYOUT_UNSUPPORTED",
        )?;
    }
    Ok(PathBuf::from(model::string(selected[0], "Source")?))
}
pub(crate) fn temporary_name(operation: &Operation, purpose: &str) -> String {
    format!(
        "{}-{purpose}-{}",
        operation
            .plan
            .container
            .chars()
            .take(24)
            .collect::<String>(),
        &operation.plan.operation[..16]
    )
}
fn new_id() -> Result<String> {
    let mut raw = [0u8; 16];
    getrandom::getrandom(&mut raw)
        .map_err(|_| DeploymentError::new("DEPLOYMENT_ENTROPY_UNAVAILABLE"))?;
    Ok(raw.iter().map(|b| format!("{b:02x}")).collect())
}
