use reverie_host::{
    memory_instance::InstanceLoadError, memory_lifecycle::LifecycleError,
    memory_namespace::NamespaceError,
};
use reverie_store::memory::MemoryError;
#[derive(Debug)]
pub enum MemoryLifecycleError {
    Configuration(InstanceLoadError),
    Namespace(NamespaceError),
    Control(LifecycleError),
    Store(MemoryError),
    Startup(crate::memory_startup::StartupError),
    Io(std::io::Error),
    Busy,
    Closed,
    Unconfirmed,
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl std::fmt::Display for MemoryLifecycleError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str(match self {
            Self::Busy => "memory lifecycle is busy",
            Self::Closed => "memory lifecycle is closed",
            Self::Unconfirmed => "memory lifecycle finalization is unconfirmed",
            Self::Store(MemoryError::NotInitialized)
            | Self::Control(LifecycleError::NotInitialized) => "memory scope is not initialized",
            Self::Store(MemoryError::NeedsProfileRefresh) => {
                "memory profile needs explicit refresh"
            }
            Self::Store(MemoryError::NeedsMigration) => "memory scope needs explicit migration",
            Self::Control(LifecycleError::Busy) => "memory lifecycle is busy",
            Self::Namespace(_) => "memory namespace refused",
            Self::Control(_) => "memory scope control refused",
            Self::Configuration(_) => "memory configuration refused",
            Self::Startup(_) => "memory startup failed",
            Self::Io(_) | Self::Store(_) => "memory operation failed",
            Self::Finalization { .. } => "memory operation and finalization failed",
        })
    }
}
impl std::error::Error for MemoryLifecycleError {}
impl From<NamespaceError> for MemoryLifecycleError {
    fn from(error: NamespaceError) -> Self {
        Self::Namespace(error)
    }
}
impl From<LifecycleError> for MemoryLifecycleError {
    fn from(error: LifecycleError) -> Self {
        Self::Control(error)
    }
}
impl From<MemoryError> for MemoryLifecycleError {
    fn from(error: MemoryError) -> Self {
        Self::Store(error)
    }
}
impl From<crate::memory_startup::StartupError> for MemoryLifecycleError {
    fn from(error: crate::memory_startup::StartupError) -> Self {
        Self::Startup(error)
    }
}
impl From<std::io::Error> for MemoryLifecycleError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}
pub(super) fn finalized<T>(
    result: super::Result<T>,
    closed: super::Result<()>,
) -> super::Result<T> {
    match (result, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(MemoryLifecycleError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
