//! Source finally's request unlink, derived solely from the actual creation.
//! The actual App lifecycle/registry and held storage exclude other supported
//! namespace writers. A hostile same-directory actor is not excluded by stat.
use super::*;
impl WorkerRuntime {
    /// Keep started requests; remove only an actually unissued or confirmed
    /// stopped unstarted request. This accepts no path/nonce/started flag.
    pub fn cleanup_created_laptop_request(&self, created: &CreatedLaptop) -> Result<()> {
        self.laptop_workflows().bound(self, &created.workflow)?;
        let mut record = created
            .workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        let creation = record
            .creation
            .as_ref()
            .ok_or(LaptopError::Refused("WORKER_LAPTOP_CREATED_OWNER_REQUIRED"))?;
        need(
            creation.owns_created(),
            "WORKER_LAPTOP_CREATED_OWNER_REQUIRED",
        )?;
        let keep = started(creation.stage);
        record.begin_cleanup()?;
        if record
            .creation
            .as_ref()
            .is_none_or(|creation| creation.publication.is_none())
        {
            return Ok(());
        }
        if !keep {
            require_unlink(self, &record)?;
        }
        let disposition = if keep {
            publication::RequestDisposition::Preserve
        } else {
            publication::RequestDisposition::Unlink
        };
        let result = record
            .creation
            .as_mut()
            .expect("actual created owner")
            .publication
            .as_mut()
            .expect("actual selected publication")
            .finish_request(disposition);
        if result.is_err() {
            record.unknown = true;
        }
        result
    }
}
fn require_unlink(runtime: &WorkerRuntime, record: &Record) -> Result<()> {
    let creation = record.creation.as_ref().expect("same actual creation");
    let unissued = matches!(
        creation.stage,
        create::CreateStage::Preparing
            | create::CreateStage::Created
            | create::CreateStage::Publishing
            | create::CreateStage::Published
    );
    let stopped = record.phase == Phase::Stopped
        && record
            .cleanup
            .as_ref()
            .is_some_and(cleanup::Cleanup::confirmed);
    need(
        record.pending.is_none() && !record.unknown && (unissued || stopped),
        "WORKER_REQUEST_LAUNCH_UNCONFIRMED",
    )?;
    let resources = record.resources();
    resources.nix.require_guard_close()?;
    resources
        .plan
        .assert_storage_owner(runtime, resources.storage())
        .map_err(LaptopError::Plan)?;
    resources
        .storage()
        .check_resource_current()
        .map_err(LaptopError::StorageOwner)?;
    storage_cleanup::require_viewer_closed(runtime, record)?;
    Ok(())
}
fn started(stage: create::CreateStage) -> bool {
    // Source sets started only after pane/status and successful guard exit;
    // Docker start ACK alone must not preserve an abandoned launch request.
    matches!(
        stage,
        create::CreateStage::NixGuardReleased
            | create::CreateStage::StartingViewer
            | create::CreateStage::Viewing
    )
}
