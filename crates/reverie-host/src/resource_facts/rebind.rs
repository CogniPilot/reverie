//! Domain-only rebind from the SAME original observer. Plans are DATA; only
//! the original pool writer's checked third CAS can mint the private receipt.
use super::*;
use crate::{
    gpu_access::GpuFileStamp, private_pending::PendingFile, reservation_control::PoolRenameFence,
    worker_runtime::WorkerStopBudget,
};
use std::{fs, os::unix::fs::MetadataExt, sync::Arc};
mod receipt;

#[must_use = "retain the actual original observer and plan through publication failure"]
pub struct ActorRebindPlan {
    identity: Arc<()>,
    before: BoundDocument,
    before_config: EffectiveWorkerConfig,
    after_config: EffectiveWorkerConfig,
    raw: Vec<u8>,
    stamp: GpuFileStamp,
    group: u32,
}
#[derive(Clone)]
pub struct ActorRebound(Arc<ReboundProof>);
struct ReboundProof {
    identity: Arc<()>,
    before: BoundDocument,
    after: BoundDocument,
    after_config: EffectiveWorkerConfig,
    stamp: GpuFileStamp,
    group: u32,
    end: Instant,
    stop: WorkerStopBudget,
}
impl InstalledFactsObserver {
    /// Consumes no installation owner and changes no facts. The existing
    /// original observer performs and checked-closes the fresh before read.
    pub fn prepare_configuration_rebind(
        &mut self,
        before: &EffectiveWorkerConfig,
        after: &EffectiveWorkerConfig,
    ) -> Result<ActorRebindPlan> {
        self.assert_finalized()?;
        let end = self
            .original
            .as_ref()
            .ok_or(ResourceFactsError::Refused("RESOURCE_INSTALL_NOT_OBSERVED"))?
            .end;
        self.observe(before, end)?;
        let bound = self
            .original
            .as_ref()
            .expect("same original observed document");
        let raw = InstalledFactsDocument::rebound_configuration_bytes(&bound.raw, before, after)?;
        self.assert_metadata(before, end)?;
        let info = fs::symlink_metadata(&bound.path).map_err(GoalCustodyError::from)?;
        PrivateBatch::check_exact_private_json(&bound.path, &bound.stamp)?;
        check(end)?;
        Ok(ActorRebindPlan {
            identity: self.identity.clone(),
            before: bound.clone(),
            before_config: before.clone(),
            after_config: after.clone(),
            raw,
            stamp: GpuFileStamp::of(&info),
            group: info.gid(),
        })
    }
}
impl ActorRebindPlan {
    pub(crate) fn original_deadline(&self) -> Instant {
        self.before.end
    }
    pub(crate) fn assert_transition(
        &self,
        before: &EffectiveWorkerConfig,
        after: &EffectiveWorkerConfig,
    ) -> Result<()> {
        need(
            reverie_contracts::worker_config::equivalent(before, &self.before_config)
                && reverie_contracts::worker_config::equivalent(after, &self.after_config),
            "RESOURCE_INSTALL_REBIND_CONFIGURATION_CHANGED",
        )?;
        need(
            InstalledFactsDocument::rebound_configuration_bytes(&self.before.raw, before, after)?
                == self.raw,
            "RESOURCE_INSTALL_REBIND_CONFIGURATION_CHANGED",
        )
    }
    pub(crate) fn assert_current(&self) -> Result<()> {
        check(self.before.end)?;
        self.before.assert_paths()?;
        let info = fs::symlink_metadata(&self.before.path).map_err(GoalCustodyError::from)?;
        need(
            GpuFileStamp::of(&info) == self.stamp && info.gid() == self.group,
            "RESOURCE_INSTALL_CHANGED",
        )
    }
    pub(crate) fn publish(
        &self,
        pending: &PendingFile,
        fence: &mut PoolRenameFence<'_>,
        stop: &WorkerStopBudget,
        end: Instant,
    ) -> Result<ActorRebound> {
        self.assert_current()?;
        let end = end.min(self.before.end);
        let clipped = stop.deadline().map_or(end, |stop| end.min(stop));
        check(clipped)?;
        let stamp = crate::gpu_access::replace_pool_configuration(
            &self.before.path,
            &self.raw,
            &self.stamp,
            self.group,
            clipped,
            pending,
            fence,
        )
        .map_err(|error| ResourceFactsError::Writer(Box::new(error)))?;
        self.rebound(stamp, stop, end)
    }
    fn rebound(
        &self,
        stamp: GpuFileStamp,
        stop: &WorkerStopBudget,
        end: Instant,
    ) -> Result<ActorRebound> {
        let info = fs::symlink_metadata(&self.before.path).map_err(GoalCustodyError::from)?;
        need(
            GpuFileStamp::of(&info) == stamp && info.gid() == self.group,
            "RESOURCE_INSTALL_CHANGED",
        )?;
        let mut after = self.before.clone();
        after.raw = self.raw.clone();
        after.stamp = Fingerprint::of(&info);
        after.domain = ResourceActorSettings::capture(&self.after_config)?
            .domain()
            .clone();
        after.end = end;
        let mut selected = false;
        for (path, identity) in &mut after.identities {
            if path == &after.path {
                *identity = native::private_goal::identity(&info);
                selected = true;
            }
        }
        need(selected, "RESOURCE_INSTALL_REBIND_ORIGINAL_REQUIRED")?;
        let receipt = ActorRebound(Arc::new(ReboundProof {
            identity: self.identity.clone(),
            before: self.before.clone(),
            after,
            after_config: self.after_config.clone(),
            stamp,
            group: self.group,
            end,
            stop: stop.clone(),
        }));
        receipt.assert_current()?;
        Ok(receipt)
    }
}
impl BoundDocument {
    pub(super) fn assert_paths(&self) -> Result<()> {
        for (path, identity) in &self.identities {
            let info = fs::symlink_metadata(path).map_err(GoalCustodyError::from)?;
            need(
                !info.file_type().is_symlink()
                    && native::private_goal::identity(&info) == *identity,
                "RESOURCE_INSTALL_CHANGED",
            )?;
        }
        match fs::symlink_metadata(self.path.with_file_name("resource-actor.installing.json")) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => {
                return Err(ResourceFactsError::Refused(
                    "RESOURCE_INSTALL_PENDING_REQUIRES_INSPECTION",
                ));
            }
        }
        PrivateBatch::check_exact_private_json(&self.path, &self.stamp)?;
        Ok(())
    }
}
