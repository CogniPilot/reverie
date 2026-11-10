//! Original read-only manager custody for an offline image transition.
use super::*;
pub(super) mod bus;
mod image;
pub use image::{ClosedImageServiceMaintenance, ImageServiceMaintenance};
pub(super) const IMAGE_PENDING: &[u8] = RetainedServicePending::Image.bytes();
use bus::{BusReader, ExpectedCommands};

#[derive(Clone, Debug)]
pub struct StoppedServiceOrigin(Arc<()>);

struct Owner {
    state: Box<State>,
    bus: Option<BusReader>,
    generation: Option<PathBuf>,
    origin: StoppedServiceOrigin,
    image_stamp: Option<image::PendingStamp>,
    #[cfg(test)]
    expected: Option<ExpectedCommands>,
}

#[must_use = "retain the original stopped service until checked finalization"]
pub struct StoppedWorkerService {
    owner: Option<Box<Owner>>,
}

#[derive(Debug)]
#[must_use = "join this receipt to the same image transition"]
pub struct ClosedStoppedWorkerService {
    source: PathBuf,
    generation: PathBuf,
    origin: StoppedServiceOrigin,
}
impl ClosedStoppedWorkerService {
    pub fn source(&self) -> &Path {
        &self.source
    }
    pub fn generation(&self) -> &Path {
        &self.generation
    }
    pub fn belongs_to(&self, origin: &StoppedServiceOrigin) -> bool {
        Arc::ptr_eq(&self.origin.0, &origin.0)
    }
}

pub struct StoppedServiceFailure {
    owner: Option<StoppedWorkerService>,
    primary: WorkerServiceError,
}
impl std::fmt::Debug for StoppedServiceFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoppedServiceFailure")
            .field("primary", &self.primary)
            .finish_non_exhaustive()
    }
}
impl std::fmt::Display for StoppedServiceFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.primary.fmt(f)
    }
}
impl std::error::Error for StoppedServiceFailure {}
impl StoppedServiceFailure {
    pub fn primary_error(&self) -> &WorkerServiceError {
        &self.primary
    }
    pub fn close_components(&mut self) -> Result<()> {
        self.owner
            .as_mut()
            .map_or(Ok(()), StoppedWorkerService::close_components)
    }
}

/// Reads the real registered unit and fixed native manager. It performs no
/// stop, start, reload, image load, admission or configuration publication.
pub fn capture_stopped_worker_service(
    source: &Path,
    end: Instant,
) -> std::result::Result<StoppedWorkerService, Box<StoppedServiceFailure>> {
    let state = State::capture(source, end, &WorkerServiceAction::Status).map_err(|primary| {
        Box::new(StoppedServiceFailure {
            owner: None,
            primary,
        })
    })?;
    capture_state(state)
}
pub fn capture_stopped_worker_service_for_role(
    source: &Path,
    end: Instant,
    role: NativeWorkerServiceRole,
) -> std::result::Result<StoppedWorkerService, Box<StoppedServiceFailure>> {
    let state = State::capture_for_role(source, end, &WorkerServiceAction::Status, role).map_err(
        |primary| {
            Box::new(StoppedServiceFailure {
                owner: None,
                primary,
            })
        },
    )?;
    capture_state(state)
}
fn capture_state(
    state: State,
) -> std::result::Result<StoppedWorkerService, Box<StoppedServiceFailure>> {
    let mut proof = StoppedWorkerService::new(state);
    let result = proof.capture_bus().and_then(|()| proof.revalidate());
    match result {
        Ok(()) => Ok(proof),
        Err(primary) => Err(Box::new(StoppedServiceFailure {
            owner: Some(proof),
            primary,
        })),
    }
}
/// Only the whole deployment coordinator captures this longer original
/// maintenance window. Ordinary read/image/PERF constructors stay unchanged.
pub(super) fn capture_deployment_maintenance(
    source: &Path,
    end: Instant,
    role: NativeWorkerServiceRole,
) -> std::result::Result<StoppedWorkerService, Box<StoppedServiceFailure>> {
    let state = State::capture_deployment_maintenance(source, end, role).map_err(|primary| {
        Box::new(StoppedServiceFailure {
            owner: None,
            primary,
        })
    })?;
    capture_state(state)
}
impl StoppedWorkerService {
    fn new(state: State) -> Self {
        Self {
            owner: Some(Box::new(Owner {
                state: Box::new(state),
                bus: None,
                generation: None,
                origin: StoppedServiceOrigin(Arc::new(())),
                image_stamp: None,
                #[cfg(test)]
                expected: None,
            })),
        }
    }
    fn capture_bus(&mut self) -> Result<()> {
        let owner = self.owner.as_mut().expect("original stopped service");
        owner.bus = Some(BusReader::capture(&owner.state)?);
        Ok(())
    }
    pub fn source(&self) -> &Path {
        &self
            .owner
            .as_ref()
            .expect("original stopped service")
            .state
            .source
    }
    pub fn end(&self) -> Instant {
        self.owner
            .as_ref()
            .expect("original stopped service")
            .state
            .end
    }
    pub fn origin(&self) -> StoppedServiceOrigin {
        self.owner
            .as_ref()
            .expect("original stopped service")
            .origin
            .clone()
    }
    pub fn revalidate(&mut self) -> Result<()> {
        let owner = self.owner.as_mut().expect("original stopped service");
        let before = owner.observe()?;
        let expected = owner.expected(&before)?;
        owner
            .bus
            .as_mut()
            .expect("original bus reader")
            .verify(&expected)?;
        let after = owner.observe()?;
        need(before == after, "NATIVE_STOPPED_SERVICE_GENERATION_CHANGED")?;
        owner.generation = Some(after);
        Ok(())
    }
    pub fn finish(
        mut self,
    ) -> std::result::Result<ClosedStoppedWorkerService, Box<StoppedServiceFailure>> {
        let body = self.revalidate();
        let closed = self.close_components();
        match finalized(body, closed) {
            Ok(()) => {
                let owner = self.owner.take().expect("same closed owner");
                Ok(ClosedStoppedWorkerService {
                    source: owner.state.source.clone(),
                    generation: owner
                        .generation
                        .clone()
                        .expect("observed closed generation"),
                    origin: owner.origin.clone(),
                })
            }
            Err(primary) => Err(Box::new(StoppedServiceFailure {
                owner: Some(self),
                primary,
            })),
        }
    }
    fn close_components(&mut self) -> Result<()> {
        let owner = self.owner.as_mut().expect("original stopped service");
        let bus = owner.bus.as_mut().map_or(Ok(()), BusReader::close);
        finalized(bus, owner.state.close())
    }
}
impl Owner {
    fn observe(&mut self) -> Result<PathBuf> {
        let observed = self.state.observe()?;
        self.state.assert_stoppable(&observed)?;
        observed.require_action_finished(&WorkerServiceAction::Stop)?;
        need(
            self.generation
                .as_ref()
                .is_none_or(|prior| prior == &observed.fragment),
            "NATIVE_STOPPED_SERVICE_GENERATION_CHANGED",
        )?;
        Ok(observed.fragment)
    }
    fn expected(&mut self, generation: &Path) -> Result<ExpectedCommands> {
        #[cfg(test)]
        if let Some(expected) = &self.expected {
            return Ok(expected.clone());
        }
        let raw = self.state.read_immutable(generation)?;
        ExpectedCommands::capture(&raw, &self.state.home)
    }
}
impl Drop for StoppedWorkerService {
    fn drop(&mut self) {
        std::mem::forget(self.owner.take());
    }
}

#[cfg(test)]
impl StoppedWorkerService {
    pub(super) fn from_state_for_test(
        state: State,
    ) -> std::result::Result<Self, Box<StoppedServiceFailure>> {
        let mut proof = Self::new(state);
        let owner = proof.owner.as_mut().unwrap();
        owner.bus = Some(BusReader::controlled(&owner.state).unwrap());
        owner.expected = Some(ExpectedCommands::controlled(&owner.state.home));
        match proof.revalidate() {
            Ok(()) => Ok(proof),
            Err(primary) => Err(Box::new(StoppedServiceFailure {
                owner: Some(proof),
                primary,
            })),
        }
    }
}
