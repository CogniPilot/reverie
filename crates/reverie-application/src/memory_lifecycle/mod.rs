//! Installed namespace memory startup and read-only recall. The real launcher
//! still supplies authenticated scope; labels, config and these locks do not.
//! No operation accepts a database/config/model path, owner ID or generic write.
mod error;
mod operation;
use crate::{
    memory_recall::MemoryRecall,
    memory_startup::{MemorySeed, StartupReport},
};
pub use error::MemoryLifecycleError;
use reverie_contracts::memory::MemoryView;
use reverie_core::memory::{EmbeddingText, MemoryScope};
use reverie_core::shutdown::ShutdownStatus;
use reverie_host::{
    embeddings::EmbeddingCandidates, memory_configuration::MemoryConfiguration,
    memory_namespace::MemoryNamespace,
};
use std::sync::{Mutex, MutexGuard, TryLockError};
type Result<T> = std::result::Result<T, MemoryLifecycleError>;
#[derive(Clone)]
pub enum ScopeStartupReport {
    Private(StartupReport),
    Project,
}
#[must_use = "retain the installed service and explicitly close before namespace shutdown"]
pub struct InstalledMemory {
    state: Mutex<State>,
}
struct State {
    namespace: MemoryNamespace,
    configuration: MemoryConfiguration,
    candidates: EmbeddingCandidates,
    pending: Option<operation::Resources>,
    closed: bool,
}
impl InstalledMemory {
    /// Bootstrap only, in the real calling process filesystem/network scope.
    /// Captures configuration/candidates once without probing or creating state.
    pub fn capture_current() -> Result<Self> {
        Self::capture_instance(None)
    }
    pub fn capture_instance(instance: Option<&std::path::Path>) -> Result<Self> {
        let mut namespace = MemoryNamespace::capture_current()?;
        let configured = MemoryConfiguration::capture_instance(instance)
            .map_err(MemoryLifecycleError::Configuration)
            .and_then(|configuration| {
                namespace.assert_current()?;
                let candidates = configuration.embedding_candidates();
                Ok((configuration, candidates))
            });
        match configured {
            Ok((configuration, candidates)) => Ok(Self {
                state: Mutex::new(State {
                    namespace,
                    configuration,
                    candidates,
                    pending: None,
                    closed: false,
                }),
            }),
            Err(primary) => error::finalized(Err(primary), namespace.close().map_err(Into::into)),
        }
    }
    /// Explicit lifecycle operation; never called by recall. Installation owns
    /// startup permission and seeds, not a caller-provided ready/config marker.
    pub fn startup(&self, scope: &MemoryScope, seeds: &[MemorySeed]) -> Result<ScopeStartupReport> {
        let mut state = self.admit()?;
        let mut resources = operation::Resources::default();
        let result = state.startup(scope, seeds, &mut resources);
        state.finish(result, resources)
    }
    pub fn recall(&self, scope: &MemoryScope, query: EmbeddingText<'_>) -> Result<Vec<MemoryView>> {
        let mut state = self.admit()?;
        let mut resources = operation::Resources::default();
        let result = state.recall(scope, query, &mut resources);
        state.finish(result, resources)
    }
    /// Nonblocking busy refusal while a recall/startup owns inference or data.
    /// A failed SQLite close retains its actual scope lock until checked close.
    pub fn close(&self) -> Result<()> {
        self.shutdown().into_result()
    }
    /// A consumed negative finalizer stays refused; only actual pending owned
    /// work keeps a standalone caller alive. Neither outcome grants a release.
    pub fn shutdown(&self) -> ShutdownStatus<MemoryLifecycleError> {
        let mut state = match self.lock() {
            Ok(state) => state,
            Err(error) => return ShutdownStatus::Pending(error),
        };
        state.closed = true;
        let mut result = Ok(());
        if let Some(pending) = &mut state.pending {
            match pending.close() {
                Ok(()) => state.pending = None,
                Err(operation::CloseFailure::Pending(error)) => {
                    return ShutdownStatus::Pending(error);
                }
                Err(operation::CloseFailure::Consumed(error)) => result = Err(error),
            }
        }
        // A consumed control failure must not skip the remaining namespace
        // finalizers. Keep both failures and the persistent service fence.
        match error::finalized(result, state.namespace.close().map_err(Into::into)) {
            Ok(()) => ShutdownStatus::Complete,
            Err(error) => ShutdownStatus::Refused(error),
        }
    }
    fn lock(&self) -> Result<MutexGuard<'_, State>> {
        self.state.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => MemoryLifecycleError::Busy,
            TryLockError::Poisoned(_) => MemoryLifecycleError::Unconfirmed,
        })
    }
    fn admit(&self) -> Result<MutexGuard<'_, State>> {
        let state = self.lock()?;
        if state.closed {
            return Err(MemoryLifecycleError::Closed);
        }
        if state.pending.is_some() {
            return Err(MemoryLifecycleError::Unconfirmed);
        }
        state.namespace.assert_current()?;
        Ok(state)
    }
}
impl State {
    fn finish<T>(&mut self, result: Result<T>, mut resources: operation::Resources) -> Result<T> {
        let checked = error::finalized(result, self.namespace.assert_current().map_err(Into::into));
        let closed = resources.close();
        if closed.is_err() {
            self.pending = Some(resources);
        }
        error::finalized(checked, closed.map_err(operation::CloseFailure::into_error))
    }
}
