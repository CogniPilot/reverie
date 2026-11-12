//! One stopped-target GPU transition publishes its original three files under
//! the same admission and pending owner. The receipt contains checked readback.
use super::*;
use crate::gpu_access::consumers::{terminal_paths, terminal_present_checked};
use crate::{
    reservation_control::AdmissionLock,
    resource_facts::{ActorRebindPlan, ActorRebound},
    worker_runtime::WorkerStopBudget,
};
use std::os::unix::fs::MetadataExt;
#[cfg(test)]
mod tests;

pub struct GpuActorPublicationInput<'a> {
    pub configuration: &'a GpuFileStamp,
    pub binding: &'a GpuFileStamp,
    pub actor: &'a ActorRebindPlan,
    pub admission: &'a AdmissionLock,
    pub cdi: Option<&'a CdiObservation>,
}
#[must_use = "retain all three actual publication facts through original admission close"]
pub struct GpuActorPublication {
    original_intent: Arc<GpuTransitionIntent>,
    original_pending: GpuFileStamp,
    stores: Arc<WorkerProtectedStores>,
    terminal_paths: Vec<PathBuf>,
    configuration: (PathBuf, GpuFileStamp),
    binding: (PathBuf, GpuFileStamp),
    actor: ActorRebound,
}
impl GpuActorPublication {
    pub fn actor(&self) -> &ActorRebound {
        &self.actor
    }
    pub fn assert_live(&self) -> Result<()> {
        need(Instant::now() < self.deadline(), "GPU_APPLY_DEADLINE")
    }
    pub fn deadline(&self) -> Instant {
        self.actor.deadline()
    }
    pub fn assert_current(&self) -> Result<()> {
        need(
            !terminal_present_checked(&self.terminal_paths)?,
            "GPU_TERMINAL_REBIND_REQUIRED",
        )?;
        self.actor
            .assert_current()
            .map_err(GpuHostError::actor_rebind)?;
        need(self.stores.unchanged()?, "GPU_PROTECTED_STORES_CHANGED")?;
        for (path, stamp) in [&self.configuration, &self.binding] {
            need(
                GpuFileStamp::observe(path)? == *stamp,
                "GPU_TERMINAL_CAS_CHANGED",
            )?;
        }
        self.actor
            .assert_current()
            .map_err(GpuHostError::actor_rebind)
    }
}
pub(crate) struct GpuRenameFence<'a> {
    pending: &'a PendingFile,
    pending_stamp: &'a GpuFileStamp,
    intent: &'a GpuTransitionIntent,
    end: Instant,
    stop: &'a WorkerStopBudget,
    request: &'a GpuFileStamp,
    files: &'a GpuControlFiles,
    input: GpuActorPublicationInput<'a>,
    stores: &'a WorkerProtectedStores,
    terminal_paths: &'a [PathBuf],
    actor_stamp: &'a mut Option<GpuFileStamp>,
}
pub(super) struct PublicationCustody {
    configuration: FilePublication,
    binding: FilePublication,
    stores: Arc<WorkerProtectedStores>,
    terminal_paths: Vec<PathBuf>,
    actor_stamp: Option<GpuFileStamp>,
}
struct FilePublication {
    path: PathBuf,
    before: GpuFileStamp,
    group: u32,
    after: Option<GpuFileStamp>,
}
impl FilePublication {
    fn capture(path: PathBuf, before: &GpuFileStamp) -> Result<Self> {
        let info = fs::symlink_metadata(&path)?;
        need(
            GpuFileStamp::of(&info) == *before,
            "GPU_PUBLICATION_SOURCE_CHANGED",
        )?;
        Ok(Self {
            path,
            before: before.clone(),
            group: info.gid(),
            after: None,
        })
    }
    fn publish(
        &mut self,
        fence: &mut GpuRenameFence<'_>,
        bytes: &[u8],
    ) -> Result<(PathBuf, GpuFileStamp)> {
        let stamp = fence.replace(&self.path, bytes, &self.before, self.group)?;
        Ok((self.path.clone(), self.after.insert(stamp).clone()))
    }
}
impl GpuPendingFile {
    pub fn publish_with_actor(
        &mut self,
        files: &GpuControlFiles,
        input: GpuActorPublicationInput<'_>,
    ) -> Result<GpuActorPublication> {
        self.publish_actor(files, input, terminal_paths()?)
    }
    fn publish_actor(
        &mut self,
        files: &GpuControlFiles,
        input: GpuActorPublicationInput<'_>,
        terminal_paths: Vec<PathBuf>,
    ) -> Result<GpuActorPublication> {
        let owner = self
            .actor_owner
            .as_ref()
            .ok_or(GpuHostError::Refused("GPU_ORIGINAL_ADMISSION_CHANGED"))?;
        need(
            Arc::ptr_eq(&owner.admission, input.admission.acquisition()),
            "GPU_ORIGINAL_ADMISSION_CHANGED",
        )?;
        need(!self.actor_attempted, "GPU_APPLY_REQUIRES_RECONCILIATION")?;
        self.actor_attempted = true;
        let custody = self.capture_publication(files, &input, terminal_paths)?;
        let custody = self.actor_custody.insert(Box::new(custody));
        let mut fence = GpuRenameFence {
            pending: &self.file,
            pending_stamp: &self.stamp,
            intent: &self.intent,
            end: self.end,
            stop: &owner.stop,
            request: &owner.request,
            files,
            input,
            stores: &custody.stores,
            terminal_paths: &custody.terminal_paths,
            actor_stamp: &mut custody.actor_stamp,
        };
        fence.assert_current()?;
        let configuration = custody
            .configuration
            .publish(&mut fence, &self.intent.configuration_bytes())?;
        let result = (|| {
            let binding = custody
                .binding
                .publish(&mut fence, &self.intent.binding_bytes())?;
            let plan = fence.input.actor;
            let actor = plan
                .publish_gpu(&mut fence)
                .map_err(GpuHostError::actor_rebind)?;
            Ok((binding, actor))
        })();
        let (binding, actor) =
            result.map_err(|error| GpuHostError::PublicationUnknown(Box::new(error)))?;
        Ok(GpuActorPublication {
            original_intent: Arc::clone(&self.intent),
            original_pending: self.stamp.clone(),
            stores: Arc::clone(&custody.stores),
            terminal_paths: custody.terminal_paths.clone(),
            configuration,
            binding,
            actor,
        })
    }
    fn capture_publication(
        &self,
        files: &GpuControlFiles,
        input: &GpuActorPublicationInput<'_>,
        terminal_paths: Vec<PathBuf>,
    ) -> Result<PublicationCustody> {
        let source = files.source()?.to_owned();
        let binding = files.binding_path()?;
        let before = files.read_configuration()?;
        let bound = files.read_binding()?;
        need(
            before.stamp() == input.configuration
                && bound.stamp() == input.binding
                && reverie_contracts::gpu_access::private_config_matches(
                    self.intent.before(),
                    before.metadata(),
                )
                && self
                    .intent
                    .before_binding()
                    .matches_metadata(bound.metadata()),
            "GPU_PUBLICATION_SOURCE_CHANGED",
        )?;
        input
            .actor
            .assert_transition(self.intent.before(), self.intent.after())
            .map_err(GpuHostError::actor_rebind)?;
        Ok(PublicationCustody {
            configuration: FilePublication::capture(source, before.stamp())?,
            binding: FilePublication::capture(binding, bound.stamp())?,
            stores: Arc::new(WorkerProtectedStores::capture_pool(&files.config)?),
            terminal_paths,
            actor_stamp: None,
        })
    }
    pub fn release_with_actor(&mut self, published: &GpuActorPublication) -> Result<()> {
        need(
            self.actor_attempted
                && Arc::ptr_eq(&self.intent, &published.original_intent)
                && self.stamp == published.original_pending,
            "GPU_ACTOR_PUBLICATION_CHANGED",
        )?;
        let owner = self
            .actor_owner
            .as_ref()
            .ok_or(GpuHostError::Refused("GPU_ORIGINAL_ADMISSION_CHANGED"))?;
        owner.admission.assert_closed().map_err(admission_error)?;
        published.assert_current()?;
        self.file
            .release_with_stop(published.actor.deadline(), &owner.stop)
            .map_err(gpu_error)
    }
}
impl GpuRenameFence<'_> {
    pub(crate) fn assert_current(&self) -> Result<()> {
        self.assert_deadline()?;
        need(
            !terminal_present_checked(self.terminal_paths)?,
            "GPU_TERMINAL_REBIND_REQUIRED",
        )?;
        let binding = self.intent.before_binding();
        let check_lock = || {
            self.input
                .admission
                .assert_current(&self.files.config, binding)
                .map_err(admission_error)
        };
        check_lock()?;
        self.pending.assert_current().map_err(gpu_error)?;
        assert_pending(self.files, self.pending, self.pending_stamp, self.intent)?;
        self.input
            .actor
            .assert_current()
            .map_err(GpuHostError::actor_rebind)?;
        need(
            GpuFileStamp::observe_optional(&self.files.requests_path()?)?.as_ref()
                == Some(self.request),
            "GPU_REQUEST_CHANGED",
        )?;
        need(self.stores.unchanged()?, "GPU_PROTECTED_STORES_CHANGED")?;
        if let Some(cdi) = self.input.cdi {
            cdi.assert_current()?;
        }
        check_lock()?;
        self.pending.assert_current().map_err(gpu_error)?;
        self.assert_deadline()
    }
    pub(crate) fn assert_deadline(&self) -> Result<()> {
        need(Instant::now() < self.deadline(), "GPU_APPLY_DEADLINE")
    }
    fn deadline(&self) -> Instant {
        let end = self.end.min(self.input.actor.original_deadline());
        self.stop.deadline().map_or(end, |stop| end.min(stop))
    }
    pub(crate) fn stop(&self) -> &WorkerStopBudget {
        self.stop
    }
    pub(crate) fn original_end(&self) -> Instant {
        self.end
    }
    pub(crate) fn replace_actor(
        &mut self,
        path: &Path,
        bytes: &[u8],
        expected: &GpuFileStamp,
        group: u32,
    ) -> Result<GpuFileStamp> {
        need(self.actor_stamp.is_none(), "GPU_ACTOR_PUBLICATION_CHANGED")?;
        let stamp = self.replace(path, bytes, expected, group)?;
        let known = self.actor_stamp.insert(stamp).clone();
        #[cfg(test)]
        crate::gpu_access::files::tests::hit(
            crate::gpu_access::files::tests::Point::ActorReadback,
            path.parent()
                .ok_or(GpuHostError::Refused("GPU_PARENT_CUSTODY"))?,
            path.file_name()
                .ok_or(GpuHostError::Refused("GPU_PARENT_CUSTODY"))?,
        )?;
        Ok(known)
    }
    fn replace(
        &mut self,
        path: &Path,
        bytes: &[u8],
        expected: &GpuFileStamp,
        group: u32,
    ) -> Result<GpuFileStamp> {
        let pending = self.pending;
        let end = self.deadline();
        replace_mode(
            path,
            bytes,
            Some(expected),
            Some((group, end, pending)),
            Some(ConfigurationRenameFence::GpuActor(self)),
        )?
        .ok_or(GpuHostError::Refused("GPU_PUBLICATION_READBACK_REQUIRED"))
    }
}
