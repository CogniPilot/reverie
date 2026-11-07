//! Staged native read owner. The application adopts it before any SQL probe.
use super::*;
use rusqlite::config::DbConfig;
#[cfg(test)]
mod tests;

struct State {
    profile: MemoryReadProfile,
    qualified: bool,
    closing: bool,
}
#[must_use = "retain the actual SQLite connection and source anchors until shutdown completes"]
pub struct NativeMemoryRead {
    state: Mutex<State>,
}
impl std::fmt::Debug for NativeMemoryRead {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output
            .debug_struct("NativeMemoryRead")
            .finish_non_exhaustive()
    }
}
impl NativeMemoryRead {
    /// Opens read-only SQLite without qualifying schema or selecting a model.
    /// Caller identity and permission come from the installing application.
    pub fn capture(path: impl AsRef<Path>) -> Result<Self> {
        let path = normalized_store_path(path.as_ref());
        if is_memory_name(&path) || !path.try_exists()? {
            return Err(MemoryError::NotInitialized);
        }
        let (db, source) = startup::capture_reader(&path)?;
        Ok(Self {
            state: Mutex::new(State {
                profile: MemoryReadProfile {
                    connection: Some(db),
                    source: Some(source),
                },
                qualified: false,
                closing: false,
            }),
        })
    }
    /// Run only after the application has stored this same actual owner.
    pub fn qualify(&self) -> Result<()> {
        let mut state = self.state.lock().map_err(|_| MemoryError::Poisoned)?;
        if state.closing {
            return Err(MemoryError::ReadinessUnconfirmed);
        }
        let profile = &state.profile;
        let db = profile.connection.as_ref().ok_or(MemoryError::Closed)?;
        let source = profile
            .source
            .as_ref()
            .ok_or(MemoryError::ReadinessUnconfirmed)?;
        db.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)?;
        source.assert_identity(db)?;
        super::qualify(db)?;
        // Recall uses ordinary WAL coordination, not an immutable snapshot
        // retained across inference. Persisted identity remains pinned.
        source.assert_identity(db)?;
        state.qualified = true;
        Ok(())
    }
    /// A refused move returns the complete owner, including poisoned state.
    pub fn into_profile(mut self) -> std::result::Result<MemoryReadProfile, Box<Self>> {
        let ready = self.state.get_mut().is_ok_and(|state| {
            !state.closing && state.qualified && state.profile.connection.is_some()
        });
        if !ready {
            return Err(Box::new(self));
        }
        let state = self
            .state
            .get_mut()
            .expect("checked exclusively owned mutex");
        Ok(std::mem::replace(
            &mut state.profile,
            MemoryReadProfile {
                connection: None,
                source: None,
            },
        ))
    }
    pub fn shutdown(&self) -> ShutdownStatus<MemoryError> {
        match self.state.lock() {
            Ok(mut state) => {
                state.qualified = false;
                state.closing = true;
                state.profile.shutdown()
            }
            Err(_) => ShutdownStatus::Pending(MemoryError::Poisoned),
        }
    }
    pub(super) fn failed(self, primary: MemoryError) -> MemoryError {
        match self.shutdown() {
            ShutdownStatus::Complete => primary,
            ShutdownStatus::Refused(secondary) => {
                finalized::<()>(Err(primary), Err(secondary)).unwrap_err()
            }
            ShutdownStatus::Pending(secondary) => MemoryError::NativeReadPending {
                primary: Box::new(finalized::<()>(Err(primary), Err(secondary)).unwrap_err()),
                reader: Box::new(self),
            },
        }
    }
}
