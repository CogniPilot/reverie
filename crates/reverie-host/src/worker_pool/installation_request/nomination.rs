//! Explicit OS-owner DATA import. Nothing here authenticates a website owner,
//! grants administration, installs a controller or changes a worker policy.
use super::{RequestSource, os_root};
use crate::{
    goal_custody::files::{Fingerprint, PrivateBatch},
    gpu_access::{GpuControlFiles, GpuPrivateSnapshot, WorkerProtectedStores},
    native,
    website_facts::{ImmutableInputKind, ImmutableInputObserver, ObservedImmutableInput},
    worker_pool::{PoolTargetObservation, compiled_pool_image_inputs_reference},
    worker_runtime::WorkerRuntime,
};
use reverie_contracts::{
    reservation_engine::ReservationConfiguration,
    resource_actor::{PoolImageInputsData, PoolInstallationRequestData},
    worker_config::EffectiveWorkerConfig,
};
use std::{
    fs::{self, File},
    io::Write,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    time::Instant,
};
mod error;
mod publish;
pub use error::{PoolNominationError, PoolNominationFailure};
type Result<T> = std::result::Result<T, PoolNominationError>;

/// Known checked publication of selection DATA, never setup/readiness consent.
pub struct PoolNominationPublished {
    path: PathBuf,
    digest: String,
}
impl PoolNominationPublished {
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn request_digest(&self) -> &str {
        &self.digest
    }
}
struct NominationOwner {
    source: Option<PathBuf>,
    config: ReservationConfiguration,
    selection: PathBuf,
    runtime: WorkerRuntime,
    input: Option<PrivateBatch>,
    input_stamp: Option<Fingerprint>,
    raw: Option<Vec<u8>>,
    request: Option<PoolInstallationRequestData>,
    immutable: ImmutableInputObserver,
    image_raw: Option<ObservedImmutableInput>,
    images: Option<PoolImageInputsData>,
    target: Option<PoolTargetObservation>,
    directories: Option<RequestSource>,
    directory_identities: Vec<(PathBuf, native::private_goal::PathIdentity)>,
    before: Option<GpuPrivateSnapshot>,
    stores: Option<WorkerProtectedStores>,
    output: Option<File>,
    output_stamp: Option<native::PrivateFileStamp>,
    end: Instant,
    attempted: bool,
    runtime_closed: bool,
}
pub fn publish_os_pool_nomination(
    source: Option<&Path>,
    config: &EffectiveWorkerConfig,
    selection: &Path,
    runtime: WorkerRuntime,
    end: Instant,
) -> std::result::Result<PoolNominationPublished, Box<PoolNominationFailure>> {
    let mut owner = Box::new(NominationOwner {
        source: source.map(Path::to_owned),
        config: ReservationConfiguration::capture(config.clone()),
        selection: selection.to_owned(),
        runtime,
        input: None,
        input_stamp: None,
        raw: None,
        request: None,
        immutable: Default::default(),
        image_raw: None,
        images: None,
        target: None,
        directories: None,
        directory_identities: Vec::new(),
        before: None,
        stores: None,
        output: None,
        output_stamp: None,
        end,
        attempted: false,
        runtime_closed: false,
    });
    let body = owner.prepare().and_then(|()| owner.publish());
    let cleanup = owner.close();
    let finished = finalized(body, cleanup).and_then(|published| {
        owner.assert_terminal_metadata()?;
        Ok(published)
    });
    match finished {
        Ok(published) => Ok(published),
        Err(cause) => Err(Box::new(PoolNominationFailure::new(owner, cause))),
    }
}
impl NominationOwner {
    fn prepare(&mut self) -> Result<()> {
        self.current()?;
        let root = os_root()?;
        let uid = native::uid();
        let gid = nix::unistd::getgid().as_raw();
        need(
            uid > 0
                && uid == nix::unistd::geteuid().as_raw()
                && gid == nix::unistd::getegid().as_raw()
                && self.runtime.worker_identity().ids().uid() == uid
                && self.runtime.worker_identity().ids().gid() == gid
                && self.config.uid()? == uid,
            "POOL_NOMINATION_ORDINARY_OWNER",
        )?;
        let source = self.source.as_ref().ok_or(PoolNominationError::Refused(
            "POOL_NOMINATION_ORIGINAL_SOURCE_REQUIRED",
        ))?;
        need(
            source.starts_with(&root) && fs::canonicalize(source)? == *source,
            "POOL_NOMINATION_ORIGINAL_SOURCE_REQUIRED",
        )?;
        let files = GpuControlFiles::capture(source, self.config.configuration());
        self.before = Some(files.read_configuration()?);
        self.assert_source()?;
        self.stores = Some(WorkerProtectedStores::capture(&self.config)?);
        self.directories = Some(RequestSource {
            root,
            directories: Vec::new(),
        });
        self.directories
            .as_mut()
            .expect("retained fixed path owner")
            .open()?;
        let directories = self
            .directories
            .as_ref()
            .expect("retained fixed path owner");
        for (index, path) in [
            directories.root.clone(),
            directories.root.join("worker-pool"),
        ]
        .into_iter()
        .enumerate()
        {
            let info = directories.directories[index].metadata()?;
            self.directory_identities
                .push((path, native::private_goal::identity(&info)));
        }
        self.input = Some(PrivateBatch::new()?);
        let input = self.input.as_mut().expect("retained input reader");
        let (stamp, raw) = input.read_exact_private_json(&self.selection)?;
        self.input_stamp = Some(stamp);
        self.raw = Some(raw);
        self.request = Some(PoolInstallationRequestData::decode(
            self.raw.as_ref().expect("original input bytes"),
        )?);
        let policy = self
            .request
            .as_ref()
            .expect("decoded original request")
            .policy();
        let directory = self.directories.as_ref().expect("original fixed root");
        need(
            directory.root.to_str() == Some(policy.instance_root.as_str())
                && policy.broker_uid == uid
                && policy.broker_gid == gid
                && policy.deployment == self.config.deployment()?,
            "POOL_NOMINATION_INSTANCE",
        )?;
        self.observe_images()?;
        self.close_preflight()?;
        self.assert_preflight()
    }
    fn observe_images(&mut self) -> Result<()> {
        let reference = compiled_pool_image_inputs_reference()?.ok_or(
            PoolNominationError::Refused("POOL_IMAGE_FIXED_REFERENCE_REQUIRED"),
        )?;
        self.image_raw = Some(self.immutable.observe_artifact(
            &reference,
            ImmutableInputKind::PoolImageInputs,
            self.end,
        )?);
        self.images = Some(PoolImageInputsData::decode(
            self.image_raw
                .as_ref()
                .expect("stored immutable input")
                .bytes(),
        )?);
        let policy = self.request.as_ref().expect("original request").policy();
        self.target = Some(PoolTargetObservation::capture(
            &self.runtime,
            policy,
            self.end,
        )?);
        let target = self.target.as_mut().expect("retained original query owner");
        target.observe(&self.runtime, policy)?;
        let observed =
            target.qualify_observed_images(self.images.as_ref().expect("original fixed images"))?;
        need(
            observed == [policy.anchor_image.clone(), policy.controller_image.clone()],
            "POOL_NOMINATION_FIXED_IMAGES",
        )
    }
    fn current(&self) -> Result<()> {
        let end = self
            .runtime
            .stop_deadline()
            .map_or(self.end, |stop| self.end.min(stop));
        need(Instant::now() < end, "POOL_NOMINATION_DEADLINE")
    }
    fn assert_source(&self) -> Result<()> {
        let source = self.source.as_ref().expect("selected original source");
        let read =
            GpuControlFiles::capture(source, self.config.configuration()).read_configuration()?;
        need(
            self.before
                .as_ref()
                .is_some_and(|before| before.stamp() == read.stamp())
                && reverie_contracts::gpu_access::private_config_matches(
                    self.config.configuration(),
                    read.metadata(),
                ),
            "POOL_NOMINATION_CONFIGURATION_CHANGED",
        )
    }
}
fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(PoolNominationError::Refused(code))
    }
}
fn finalized<T>(body: Result<T>, cleanup: Result<()>) -> Result<T> {
    match (body, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(cleanup)) => Err(PoolNominationError::Finalization(
            Box::new(primary),
            Box::new(cleanup),
        )),
    }
}
