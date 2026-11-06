//! Fixed public `reverie agent journal` transport. The real API authenticates
//! the session and readable turn. Arguments/replies are data, not owner/native
//! permission. Supported memory callers enforce their screening before save.
mod error;
mod signals;
pub use crate::captured_client::CancellationToken;
use crate::{
    captured_client::{CapturedClient, CapturedOutput, InstalledCommand, Policy},
    native,
};
pub use error::{JournalClientError, JournalClientFault};
use reverie_contracts::{
    memory_cli::{JournalEntries, JournalSaveData, JournalSaveRequest},
    storage_identity::MetadataText,
};
use reverie_core::memory::ProjectName;
pub use signals::{JournalSignalError, JournalSignals};
use std::{
    ffi::{OsStr, OsString},
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
type Result<T> = std::result::Result<T, JournalClientError>;
/// Bounded transport, independently stricter than owner-policy/model output.
/// This is not a cap on the embedding HTTP adapter or a generic process API.
pub const MAX_JOURNAL_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
#[must_use = "retain and explicitly settle the actual journal client before shutdown"]
pub struct MemoryJournalClient {
    client: CapturedClient,
    unknown_save: AtomicBool,
}
impl MemoryJournalClient {
    pub fn capture() -> Result<Option<Self>> {
        Self::capture_installed(OsStr::new("reverie"))
    }
    /// Bootstrap only. Product packaging must bind its supported Rust/TS client;
    /// there is no Python fallback or request-selected executable/argv prefix.
    pub fn capture_installed(program: &OsStr) -> Result<Option<Self>> {
        let environment = std::env::vars_os().collect::<Vec<_>>();
        if !environment
            .iter()
            .any(|(key, value)| key == OsStr::new("REVERIE_SESSION_ID") && !value.is_empty())
        {
            return Ok(None);
        }
        Self::from_snapshot(
            program,
            environment,
            std::env::current_dir()
                .map_err(|_| JournalClientError::new(JournalClientFault::Bootstrap))?,
        )
    }
    fn from_snapshot(
        program: &OsStr,
        environment: Vec<(OsString, OsString)>,
        directory: PathBuf,
    ) -> Result<Option<Self>> {
        let selected = |name: &str| {
            environment
                .iter()
                .find(|(key, _)| key == OsStr::new(name))
                .map(|(_, value)| value)
        };
        if selected("REVERIE_SESSION_ID").is_none_or(|value| value.is_empty())
            || selected("PATH").is_some_and(|value| value.is_empty())
        {
            return Ok(None);
        }
        let Some(command) = InstalledCommand::from_snapshot(program, environment, directory, true)
        else {
            return Ok(None);
        };
        Ok(Some(Self::from_command(command)))
    }
    fn from_command(command: InstalledCommand) -> Self {
        Self {
            client: CapturedClient::new(command),
            unknown_save: AtomicBool::new(false),
        }
    }
    pub fn save(
        &self,
        request: &JournalSaveRequest,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> Result<JournalSaveData> {
        if self.unknown_save.load(Ordering::Acquire) {
            return Err(JournalClientError::unknown_save());
        }
        if !request.missing().is_empty() {
            return Err(JournalClientError::new(JournalClientFault::Request));
        }
        let captured = self.call(request.arguments(), deadline, cancellation, true)?;
        let stdout = decoded(captured.stdout);
        let stderr = decoded(captured.stderr);
        JournalSaveData::decode(&stdout, &stderr, captured.succeeded).map_err(|error| {
            self.unknown_save.store(true, Ordering::Release);
            JournalClientError::reply(error, true)
        })
    }
    pub fn recall(
        &self,
        query: &MetadataText,
        project: Option<&ProjectName>,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> Result<JournalEntries> {
        let query =
            MetadataText::from_python_text(query.as_python_text_ref().trimmed().into_owned());
        if query.codepoints().is_empty() {
            return Err(JournalClientError::new(JournalClientFault::Request));
        }
        let mut arguments = vec![MetadataText::from_scalar_text("recall"), query];
        if let Some(project) = project {
            arguments.extend([
                MetadataText::from_scalar_text("--project"),
                MetadataText::from_scalar_text(project.as_str()),
            ]);
        }
        let captured = self.call(&arguments, deadline, cancellation, false)?;
        JournalEntries::decode(
            &decoded(captured.stdout),
            &decoded(captured.stderr),
            captured.succeeded,
        )
        .map_err(|error| JournalClientError::reply(error, false))
    }
    fn call(
        &self,
        arguments: &[MetadataText],
        deadline: Instant,
        cancellation: &CancellationToken,
        save: bool,
    ) -> Result<CapturedOutput> {
        let mut args = ["agent", "journal"].map(OsString::from).to_vec();
        for value in arguments {
            args.push(
                native::python_path(value.codepoints())
                    .map_err(|_| JournalClientError::new(JournalClientFault::Arguments))?
                    .into_os_string(),
            );
        }
        args.push(OsString::from("--json"));
        self.client
            .run(
                args,
                deadline,
                cancellation,
                Policy {
                    maximum: Duration::from_secs(60),
                    maximum_output: MAX_JOURNAL_OUTPUT_BYTES,
                    successful_exit: false,
                },
            )
            .map_err(|error| {
                let unknown = save && error.may_have_started;
                if unknown {
                    self.unknown_save.store(true, Ordering::Release);
                }
                JournalClientError::capture(error, unknown)
            })
    }
    /// Native child settlement only. It never clears an unconfirmed API save,
    /// retries that save, or turns a malformed reply into a positive receipt.
    pub fn close(&self, deadline: Instant) -> Result<()> {
        self.client.close(deadline).map_err(|error| {
            JournalClientError::capture(error, self.unknown_save.load(Ordering::Acquire))
        })
    }
    /// Negative completion does not clear an unconfirmed API save or admit a
    /// replacement client. Pending retains the same actual native context.
    pub fn shutdown(
        &self,
        deadline: Instant,
    ) -> reverie_core::shutdown::ShutdownStatus<JournalClientError> {
        use reverie_core::shutdown::ShutdownStatus;
        let error =
            |error| JournalClientError::capture(error, self.unknown_save.load(Ordering::Acquire));
        match self.client.shutdown(deadline) {
            ShutdownStatus::Complete => ShutdownStatus::Complete,
            ShutdownStatus::Pending(value) => ShutdownStatus::Pending(error(value)),
            ShutdownStatus::Refused(value) => ShutdownStatus::Refused(error(value)),
        }
    }
    pub fn has_unconfirmed_save(&self) -> bool {
        self.unknown_save.load(Ordering::Acquire)
    }
}
fn decoded(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes)
        .expect("shared journal capture checked UTF8")
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}
#[cfg(test)]
mod tests;
