//! Fixed post-memory publication; every local descriptor/lock closes before
//! the actual laptop owner performs its second confirmation and final release.
use super::super::{directories::Directory, leases::Bases, *};
use super::{prepare, ready::Ready, references, scope::RetirementPaths};
use crate::worker_laptop::cold_confirm::Confirmed;
use reverie_contracts::worker_cold_tmp::{
    ColdConfiguration, ReferenceReport, retained_bound_record, retained_prepared_binding,
};
use sha2::{Digest, Sha256};
use std::io::Read;
type OwnerResult<T> = std::result::Result<T, StorageOwnerError>;
#[derive(Default)]
struct Held {
    control: Option<Directory>,
    bases: Option<Bases>,
}
impl Held {
    fn check(&self, ready: &Ready, end: Instant) -> Result<()> {
        self.control.as_ref().expect("actual control fd").check()?;
        self.bases.as_ref().expect("actual bases").check(end)?;
        ready.verify(end)
    }
    fn close(mut self) -> Result<()> {
        let mut result = Ok(());
        if let Some(control) = self.control.take() {
            result = finalized(result, control.close());
        }
        if let Some(bases) = self.bases.take() {
            result = finalized(result, bases.close());
        }
        result
    }
}
pub(in crate::worker_storage::cold_tmp) fn publish(
    ready: &Ready,
    native: &Confirmed,
    end: Instant,
) -> OwnerResult<()> {
    let mut held = Held::default();
    let result = run(ready, native, &mut held, end).map_err(StorageOwnerError::Storage);
    #[cfg(test)]
    if result.is_ok() && super::faults::take(super::faults::Fault::FinishClose) {
        native::test_faults::set(None, true);
    }
    prepare::finish(result, held.close())
        .map_err(|error| StorageOwnerError::ColdUnconfirmed(Box::new(error)))
}
fn run(ready: &Ready, native: &Confirmed, held: &mut Held, end: Instant) -> Result<()> {
    ready.verify(end)?;
    let config = Configuration::capture(&ready.source)?;
    let original = super::super::super::temporary::path_text(&config, &ready.paths)?;
    let target = original.scratch().join(&PosixPath::from_scalar_text("tmp"));
    let policy = ColdConfiguration::capture(&ready.source)?
        .ok_or(StorageError::Refused(StorageFault::ColdLease))?;
    held.bases = Some(Bases::capture(
        &policy,
        original.home(),
        &target,
        config.uid(),
    )?);
    let scope = RetirementPaths::capture(&config, &ready.paths, &policy, end)?;
    held.bases.as_mut().expect("actual bases").barriers(end)?;
    held.bases
        .as_mut()
        .expect("actual barriers")
        .retained_locks(&scope, end)?;
    // The original source acquires its control fd AFTER both observations.
    // Until then check the same descriptor bases and captured ready anchors.
    let before = observe(
        ready,
        &held.bases,
        &ready.envelope.join(&PosixPath::from_scalar_text("data")),
        end,
    )?;
    let after = observe(ready, &held.bases, &target, end)?;
    held.control = Some(Directory::open(original.home().parent(), config.uid())?);
    let control = held.control.as_ref().expect("adopted control");
    need(
        ready.control.same_directory(control.stamp()),
        StorageFault::ColdTree,
    )?;
    prepared(control, ready, end)?;
    let raw = retained_bound_record(
        ready.record(),
        &ready.before,
        &ready.after,
        [&before, &after],
        native.record(),
    );
    let name = OsString::from(format!("cold-tmp-retained-{}.json", ready.attempt.as_str()));
    control.publish(&name, &raw)?;
    held.check(ready, end)
}
fn observe(
    ready: &Ready,
    bases: &Option<Bases>,
    target: &PosixPath,
    end: Instant,
) -> Result<ReferenceReport> {
    let bases = bases.as_ref().expect("actual EX barriers");
    bases.check(end)?;
    ready.verify(end)?;
    let report = references::collect(target, -1, end)?;
    bases.check(end)?;
    ready.verify(end)?;
    #[cfg(test)]
    if report.known_count() != 0 {
        let _ = reverie_diagnostics::stderr(&report.encode());
    }
    need(report.known_count() == 0, StorageFault::ColdReference)?;
    Ok(report)
}
fn prepared(control: &Directory, ready: &Ready, end: Instant) -> Result<()> {
    check(end)?;
    let name = ready.prepared_name();
    let mut file = native::open_at(
        control.file.as_raw_fd(),
        &name,
        libc::O_RDONLY | libc::O_NONBLOCK,
    )?;
    let result = (|| {
        let before = Stamp::capture(&file.metadata()?);
        need(
            before.mode & libc::S_IFMT == libc::S_IFREG && before.size <= 262144,
            StorageFault::ColdTree,
        )?;
        // Original os.read(fd,262145) is one read, rather than a renewed
        // read-to-end budget. A short read cannot match the captured digest.
        let mut raw = vec![0; 262145];
        check(end)?;
        let count = file.read(&mut raw)?;
        need(count <= 262144, StorageFault::ColdBound)?;
        raw.truncate(count);
        control.named(&name, &before)?;
        need(
            Stamp::capture(&file.metadata()?) == before
                && raw.len() as u64 == before.size
                && <[u8; 32]>::from(Sha256::digest(&raw)) == ready.prepared,
            StorageFault::ColdTree,
        )?;
        retained_prepared_binding(
            &raw,
            ready.paths.identity(),
            ready.paths.session(),
            ready.paths.owner().as_ref(),
        )?;
        check(end)
    })();
    finalized(result, fs::close(file))
}
