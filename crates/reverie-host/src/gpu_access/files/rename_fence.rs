use super::*;

/// Closed purpose selection for the existing writer, never a callback or an
/// allow-pending boolean. Image service and original-pool R keep distinct owners.
pub(super) enum ConfigurationRenameFence<'borrow, 'owner> {
    Image(&'borrow mut crate::worker_image::ImageRenameFence<'owner>),
    Pool(&'borrow mut crate::reservation_control::PoolRenameFence<'owner>),
    ActorSetup(&'borrow mut super::actor_setup::ActorSetupRenameFence<'owner>),
    ActorSetupAbsent(&'borrow mut super::actor_setup::ActorSetupRenameFence<'owner>),
}
impl ConfigurationRenameFence<'_, '_> {
    pub(super) fn assert_current(&mut self) -> Result<()> {
        match self {
            Self::Image(fence) => fence
                .assert_current()
                .map_err(|error| GpuHostError::ImageFence(Box::new(error))),
            Self::Pool(fence) => fence
                .assert_current()
                .map_err(|error| GpuHostError::PoolFence(Box::new(error))),
            Self::ActorSetup(fence) | Self::ActorSetupAbsent(fence) => fence.assert_current(),
        }
    }
    pub(super) fn publishes_absent_actor(&self) -> bool {
        matches!(self, Self::ActorSetupAbsent(_))
    }
    pub(super) fn is_actor_setup(&self) -> bool {
        matches!(self, Self::ActorSetup(_) | Self::ActorSetupAbsent(_))
    }
}
