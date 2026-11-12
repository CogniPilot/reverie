//! Selected controller decoder compatibility precedes birth publication and effects.
mod error;
use super::*;
use crate::{
    captured_client::{CapturedCall, CapturedClient, InstalledCommand},
    engine_metadata::{CancellationToken, EngineQuery, MetadataQueryOwner},
    native,
    website_facts::{ImmutableInputKind, ImmutableInputObserver},
    worker_runtime::{WorkerRuntime, WorkerStopBudget},
};
pub use error::ControllerBirthCompatibilityError;
use error::{Failure, refused};
use reverie_contracts::{
    resource_actor::{EngineMetadata, PoolImageInputsData, PoolImageRole},
    worker_image_switch::WorkerImageId,
    worker_pool::{ControllerBirthCheck, ControllerServiceBirth},
};
use std::{
    fs::File,
    io::{Seek, Write},
    path::PathBuf,
    time::Instant,
};

#[derive(PartialEq, Eq)]
enum Phase {
    Captured,
    Checking,
    Checked,
    Failed,
    Closing,
    Closed,
    CloseUnknown,
}

pub(super) struct ControllerBirthCompatibility {
    query: Option<MetadataQueryOwner>,
    decoder: Option<CapturedClient>,
    pending: Option<CapturedCall>,
    input: Option<File>,
    immutable: ImmutableInputObserver,
    stop: WorkerStopBudget,
    cancellation: CancellationToken,
    end: Instant,
    phase: Phase,
    #[cfg(test)]
    omit_reference: bool,
}
impl ControllerBirthCompatibility {
    pub(super) fn new(runtime: &WorkerRuntime, end: Instant) -> Self {
        Self {
            query: Some(runtime.readonly().capture_query_owner()),
            decoder: None,
            pending: None,
            input: None,
            immutable: ImmutableInputObserver::default(),
            stop: runtime.stop_budget(),
            cancellation: runtime.cancellation(),
            end,
            phase: Phase::Captured,
            #[cfg(test)]
            omit_reference: false,
        }
    }
    #[cfg(test)]
    pub(super) fn without_factory_for_test(runtime: &WorkerRuntime, end: Instant) -> Self {
        let mut owner = Self::new(runtime, end);
        owner.omit_reference = true;
        owner
    }
    fn deadline(&self) -> Instant {
        self.stop
            .deadline()
            .map_or(self.end, |stop| stop.min(self.end))
    }
    pub(super) fn check(&mut self, birth: &ControllerServiceBirth, raw: &[u8]) -> Result<()> {
        if self.phase != Phase::Captured {
            return Err(refused(Failure::Replayed));
        }
        self.phase = Phase::Checking;
        let result = self.check_once(birth, raw);
        self.phase = if result.is_ok() {
            Phase::Checked
        } else {
            Phase::Failed
        };
        result.map_err(error::wrap)
    }
    fn check_once(&mut self, birth: &ControllerServiceBirth, raw: &[u8]) -> Result<()> {
        let end = self.deadline();
        need(
            Instant::now() < end && !self.cancellation.is_cancelled(),
            "WORKER_POOL_CONTROLLER_BIRTH_CHECK_EXPIRED",
        )?;
        let reference = self
            .reference()?
            .ok_or_else(|| refused(Failure::Unmeasured))?;
        let measured = self
            .immutable
            .observe_artifact(&reference, ImmutableInputKind::PoolImageInputs, end)
            .map_err(|e| PoolError::BootstrapFacts(Box::new(e)))?;
        let inputs = PoolImageInputsData::decode(measured.bytes())
            .map_err(|_| refused(Failure::Unmeasured))?;
        let program = inputs
            .controller_program()
            .ok_or_else(|| refused(Failure::Unmeasured))?;
        let selected = &birth.identity().policy().controller_image;
        if selected
            != &format!(
                "sha256:{}",
                inputs
                    .archive_config_digest(PoolImageRole::Controller)
                    .as_str()
            )
        {
            return Err(refused(Failure::ImageMismatch));
        }
        self.immutable
            .observe_controller_program(program, end)
            .map_err(|e| PoolError::BootstrapFacts(Box::new(e)))?;
        let image = WorkerImageId::parse(selected).map_err(|_| refused(Failure::ImageMismatch))?;
        let raw_image = self
            .query
            .as_ref()
            .expect("retained query owner")
            .query(
                EngineQuery::WorkerImageInspect(&image),
                end,
                &self.cancellation,
            )
            .map_err(PoolError::Engine)?;
        let image = EngineMetadata::decode(raw_image.as_bytes())
            .map_err(|_| refused(Failure::ImageMismatch))?;
        if image
            .qualify_pool_image(&inputs, PoolImageRole::Controller)
            .map_err(|_| refused(Failure::ImageMismatch))?
            != *selected
        {
            return Err(refused(Failure::ImageMismatch));
        }
        self.check_decoder(program, raw, end)
    }
    fn check_decoder(
        &mut self,
        program: &reverie_contracts::resource_actor::CodeFile,
        raw: &[u8],
        end: Instant,
    ) -> Result<()> {
        if self.decoder.is_some() || self.input.is_some() || self.pending.is_some() {
            return Err(refused(Failure::Replayed));
        }
        self.immutable
            .observe_controller_program(program, end)
            .map_err(|e| PoolError::BootstrapFacts(Box::new(e)))?;
        let path = native::python_path(program.path.codepoints())?;
        let command =
            InstalledCommand::from_snapshot(path.as_os_str(), Vec::new(), PathBuf::from("/"), true)
                .ok_or_else(|| refused(Failure::Unmeasured))?;
        self.decoder = Some(CapturedClient::new(command));
        self.prepare_input(raw)?;
        let result = self
            .decoder
            .as_ref()
            .expect("retained decoder before spawn")
            .check_controller_birth(end, &self.cancellation, &mut self.input);
        let output = match result {
            Ok(output) => output,
            Err(failure) => {
                self.pending = failure.call;
                return Err(PoolError::BirthCompatibility(Box::new(
                    ControllerBirthCompatibilityError::native(failure.error.into()),
                )));
            }
        };
        if !output.stderr.is_empty() {
            return Err(refused(Failure::ReplyMismatch));
        }
        ControllerBirthCheck::verify_reply(&output.stdout, raw)
            .map_err(|_| refused(Failure::ReplyMismatch))?;
        self.immutable
            .observe_controller_program(program, end)
            .map_err(|e| PoolError::BootstrapFacts(Box::new(e)))?;
        need(
            Instant::now() < end && !self.cancellation.is_cancelled(),
            "WORKER_POOL_CONTROLLER_BIRTH_CHECK_EXPIRED",
        )
    }
    fn reference(&self) -> Result<Option<reverie_contracts::resource_actor::ArtifactReference>> {
        #[cfg(test)]
        if self.omit_reference {
            return Ok(None);
        }
        compiled_pool_image_inputs_reference().map_err(PoolError::from)
    }
    fn prepare_input(&mut self, raw: &[u8]) -> Result<()> {
        use nix::{
            fcntl::{FcntlArg, SealFlag, fcntl},
            sys::memfd::{MFdFlags, memfd_create},
        };
        need(
            !raw.is_empty() && raw.len() <= 65_536,
            "WORKER_POOL_BIRTH_INVALID",
        )?;
        self.input = Some(File::from(
            memfd_create(
                c"reverie-controller-birth",
                MFdFlags::MFD_CLOEXEC | MFdFlags::MFD_ALLOW_SEALING,
            )
            .map_err(io::Error::from)?,
        ));
        let file = self.input.as_mut().expect("owned input before write");
        file.write_all(raw)?;
        file.rewind()?;
        fcntl(
            &*file,
            FcntlArg::F_ADD_SEALS(
                SealFlag::F_SEAL_WRITE
                    | SealFlag::F_SEAL_GROW
                    | SealFlag::F_SEAL_SHRINK
                    | SealFlag::F_SEAL_SEAL,
            ),
        )
        .map_err(io::Error::from)?;
        Ok(())
    }
    pub(super) fn close(&mut self) -> Result<()> {
        if self.phase == Phase::Closed {
            return Ok(());
        }
        if matches!(self.phase, Phase::Closing | Phase::CloseUnknown) {
            return Err(refused(Failure::CloseUnknown));
        }
        self.phase = Phase::Closing;
        let end = self.deadline();
        let query = self
            .query
            .as_ref()
            .map_or(Ok(()), |q| q.settle_owned(end).map_err(PoolError::Engine));
        let decoder = self.decoder.as_ref().map_or(Ok(()), |d| {
            d.settle_owned(end).map_err(|e| PoolError::Engine(e.into()))
        });
        let input = self
            .input
            .take()
            .map_or(Ok(()), |f| native::close(f).map_err(PoolError::from));
        let immutable = self
            .immutable
            .assert_finalized()
            .map_err(|e| PoolError::BootstrapFacts(Box::new(e)));
        let result = finalized(query, finalized(decoder, finalized(input, immutable)));
        self.phase = if result.is_ok() {
            Phase::Closed
        } else {
            Phase::CloseUnknown
        };
        result
    }
}
impl Drop for ControllerBirthCompatibility {
    fn drop(&mut self) {
        if self.phase != Phase::Closed {
            std::mem::forget((
                self.query.take(),
                self.decoder.take(),
                self.pending.take(),
                self.input.take(),
            ));
        }
    }
}
#[cfg(test)]
mod tests;
