//! Standalone installed helper guest, never a host engine/command interface.
//! Every program, input and destination is fixed by the read-only worker image.
//! Retain this one-shot owner and check finish before acknowledging shutdown.
mod filesystem;
#[cfg(test)]
mod tests;
use crate::{
    captured_client::{self, CapturedClient, CapturedOutput, InstalledCommand},
    engine_metadata::CancellationToken,
    native,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::{collections::BTreeMap, ffi::OsString, fs::File, io, path::PathBuf, time::Instant};
static CAPTURED: AtomicBool = AtomicBool::new(false);

#[derive(Debug)]
pub enum SeedError {
    Io(io::Error),
    AlreadyAttempted,
    Child {
        code: u8,
    },
    Capture(crate::engine_metadata::EngineError),
    Signal {
        cause: io::Error,
        restoration_failed: bool,
    },
    PreviousFinalization,
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl SeedError {
    pub fn exit_code(&self) -> u8 {
        match self {
            Self::Child { code } => *code,
            Self::Finalization { primary, .. } => primary.exit_code(),
            _ => 1,
        }
    }
}
impl std::fmt::Display for SeedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "NIX_GUEST: {self:?}")
    }
}
impl std::error::Error for SeedError {}
impl From<io::Error> for SeedError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<io::ErrorKind> for SeedError {
    fn from(error: io::ErrorKind) -> Self {
        Self::Io(error.into())
    }
}
impl From<captured_client::Error> for SeedError {
    fn from(error: captured_client::Error) -> Self {
        Self::Capture(error.into())
    }
}
type Result<T> = std::result::Result<T, SeedError>;

struct Bootstrap {
    target: PathBuf,
    temporary: PathBuf,
    registration: PathBuf,
    base: PathBuf,
    nix_store: PathBuf,
    nix: PathBuf,
    environment: BTreeMap<OsString, OsString>,
    directory: PathBuf,
}
impl Bootstrap {
    fn installed() -> io::Result<Self> {
        Ok(Self {
            target: "/target/nix".into(),
            temporary: "/tmp".into(),
            registration: "/etc/reverie-nix-registration".into(),
            base: "/etc/reverie-nix-base".into(),
            nix_store: "/bin/nix-store".into(),
            nix: "/bin/nix".into(),
            environment: std::env::vars_os().collect(),
            directory: std::env::current_dir()?,
        })
    }
    fn environment(&self) -> BTreeMap<OsString, OsString> {
        let mut environment = self.environment.clone();
        for (key, value) in [
            (
                "HOME",
                self.temporary.join("nix-bootstrap-home").into_os_string(),
            ),
            ("TMPDIR", self.temporary.clone().into_os_string()),
            (
                "NIX_STATE_DIR",
                self.temporary.join("nix-bootstrap-state").into_os_string(),
            ),
            (
                "NIX_LOG_DIR",
                self.temporary.join("nix-bootstrap-log").into_os_string(),
            ),
            ("NIX_REMOTE", self.local_source(false).into()),
        ] {
            environment.insert(key.into(), value);
        }
        environment
    }
    fn local_source(&self, readonly: bool) -> String {
        // These are immutable installed paths. Test roots are privately
        // constructed valid UTF-8 paths; no request or wire path is accepted.
        format!(
            "local?real={}&state={}/nix-bootstrap-state&log={}/nix-bootstrap-log{}",
            if readonly {
                "/nix/store".into()
            } else {
                self.temporary
                    .join("nix-bootstrap-empty")
                    .display()
                    .to_string()
            },
            self.temporary.display(),
            self.temporary.display(),
            if readonly { "&read-only=true" } else { "" }
        )
    }
}

#[must_use = "retain the helper owner and check finish after every seed outcome"]
pub struct GuestNixSeed {
    bootstrap: Bootstrap,
    registration: Option<File>,
    clients: [Option<CapturedClient>; 2],
    cancellation: CancellationToken,
    attempted: bool,
    output: [Vec<u8>; 2],
    finalization_failed: bool,
    signals: Option<native::child_signals::SignalGuard>,
    pending: bool,
}
impl GuestNixSeed {
    pub fn installed() -> Result<Self> {
        let bootstrap = Bootstrap::installed()?;
        if CAPTURED
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(SeedError::AlreadyAttempted);
        }
        let signals = match native::child_signals::SignalGuard::install() {
            Ok(signals) => signals,
            Err(error) => {
                if !error.restoration_failed {
                    CAPTURED.store(false, Ordering::Release);
                }
                return Err(SeedError::Signal {
                    cause: error.cause,
                    restoration_failed: error.restoration_failed,
                });
            }
        };
        let mut owner = Self::new(bootstrap);
        owner.signals = Some(signals);
        Ok(owner)
    }
    fn new(bootstrap: Bootstrap) -> Self {
        Self {
            bootstrap,
            registration: None,
            clients: [None, None],
            cancellation: CancellationToken::new(),
            attempted: false,
            output: [Vec::new(), Vec::new()],
            finalization_failed: false,
            signals: None,
            pending: false,
        }
    }
    /// This is the fixed guest program only. It does not inspect or launch an
    /// engine, choose an image, grant writes or perform laptop admission.
    pub fn seed(&mut self, deadline: Instant) -> Result<()> {
        if self.attempted {
            return Err(SeedError::AlreadyAttempted);
        }
        self.attempted = true;
        filesystem::prepare(&self.bootstrap)?;
        self.registration = Some(File::open(&self.bootstrap.registration)?);
        self.run(0, vec!["--load-db".into()], deadline)?;
        filesystem::freeze_database(&self.bootstrap)?;
        let destination = self
            .bootstrap
            .target
            .parent()
            .ok_or(io::ErrorKind::InvalidInput)?;
        self.run(
            1,
            vec![
                "--extra-experimental-features".into(),
                "read-only-local-store".into(),
                "--offline".into(),
                "copy".into(),
                "--all".into(),
                "--from".into(),
                self.bootstrap.local_source(true).into(),
                "--to".into(),
                format!("local?root={}&require-sigs=false", destination.display()).into(),
            ],
            deadline,
        )?;
        filesystem::publish_root(&self.bootstrap)
    }
    fn run(&mut self, index: usize, args: Vec<OsString>, deadline: Instant) -> Result<()> {
        let program = if index == 0 {
            &self.bootstrap.nix_store
        } else {
            &self.bootstrap.nix
        };
        let command = InstalledCommand::from_service(
            program.as_os_str(),
            self.bootstrap.environment(),
            self.bootstrap.directory.clone(),
        )
        .ok_or(io::ErrorKind::NotFound)?;
        self.clients[index] = Some(CapturedClient::new(command));
        let result = self.clients[index]
            .as_ref()
            .expect("retained phase client")
            .run_nix_bootstrap(args, deadline, &self.cancellation, &mut self.registration);
        let result = result.map_err(SeedError::from)?;
        self.record_output(&result);
        if !result.succeeded {
            return Err(SeedError::Child {
                code: result.shell_code,
            });
        }
        Ok(())
    }
    fn record_output(&mut self, output: &CapturedOutput) {
        crate::captured_client::nix_tail::append(&mut self.output[0], &output.stdout);
        crate::captured_client::nix_tail::append(&mut self.output[1], &output.stderr);
        for output in &mut self.output {
            crate::captured_client::nix_tail::finish(output);
        }
    }
    /// Bounded raw diagnostic tails. Neither truncation nor invalid UTF-8
    /// changes an actual child exit status into success or failure.
    pub fn output(&self) -> (&[u8], &[u8]) {
        (&self.output[0], &self.output[1])
    }
    pub fn cancel(&self) {
        self.cancellation.cancel();
    }
    pub fn finish(&mut self, deadline: Instant) -> Result<()> {
        use reverie_core::shutdown::ShutdownStatus;
        let deadline = native::child_signals::clamp(deadline);
        self.cancellation.cancel();
        self.pending = false;
        let mut result = if self.finalization_failed {
            Err(SeedError::PreviousFinalization)
        } else {
            Ok(())
        };
        if let Some(file) = self.registration.take() {
            result = finalized(
                result,
                native::owned_process::close(file.into()).map_err(SeedError::from),
            );
        }
        for client in self.clients.iter().flatten() {
            let closed = match client.shutdown(deadline) {
                ShutdownStatus::Complete => Ok(()),
                ShutdownStatus::Pending(error) => {
                    self.pending = true;
                    Err(SeedError::from(error))
                }
                ShutdownStatus::Refused(error) => Err(SeedError::from(error)),
            };
            result = finalized(result, closed);
        }
        if !self.pending
            && let Some(signals) = self.signals.take()
        {
            result = finalized(result, signals.finish().map_err(SeedError::from));
        }
        self.finalization_failed |= result.is_err() && !self.pending;
        result
    }
    pub fn shutdown(
        &mut self,
        deadline: Instant,
    ) -> reverie_core::shutdown::ShutdownStatus<SeedError> {
        use reverie_core::shutdown::ShutdownStatus;
        match self.finish(deadline) {
            Ok(()) => ShutdownStatus::Complete,
            Err(error) if self.pending => ShutdownStatus::Pending(error),
            Err(error) => ShutdownStatus::Refused(error),
        }
    }
    pub fn termination_signal(&self) -> Option<i32> {
        native::child_signals::signal()
    }
}
fn finalized<T>(primary: Result<T>, closed: Result<()>) -> Result<T> {
    match (primary, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(SeedError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
