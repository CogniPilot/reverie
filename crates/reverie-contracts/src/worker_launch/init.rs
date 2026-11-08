//! Closed boot-layout DATA. Selection grants no create/start authority.
use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerInitData {
    LegacySleep,
    SealedNative,
}
impl WorkerInitData {
    pub fn for_effective(config: &EffectiveWorkerConfig) -> Result<Self> {
        match crate::task_perf_v1::projected_selection(config)
            .map_err(|_| LaunchDataError::Configuration)?
        {
            Some(reverie_core::task_perf::TaskPerfPolicy::TaskV2) => Ok(Self::SealedNative),
            _ => Ok(Self::LegacySleep),
        }
    }
    pub fn entrypoint(self) -> &'static str {
        match self {
            Self::LegacySleep => "/bin/sleep",
            Self::SealedNative => crate::task_perf_capsule::WORKER_INIT,
        }
    }
    pub fn command(self) -> &'static [&'static str] {
        match self {
            Self::LegacySleep => &["infinity"],
            Self::SealedNative => &[],
        }
    }
    pub fn engine_init_argument(self) -> &'static str {
        match self {
            Self::LegacySleep => "--init",
            Self::SealedNative => "--init=false",
        }
    }
}
