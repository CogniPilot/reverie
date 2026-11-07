use super::*;
use crate::{ObservationError, reservation_kernel::ReservationKernelError};
pub(super) fn visit(
    base: PathBuf,
    pid: u32,
    target: &Target,
    report: &mut ReferenceReport,
    ignored: i32,
    end: Instant,
) -> Result<()> {
    let mut before = None;
    let result = (|| {
        if !reference_credentials(&read(&base.join("status"), 65536, end)?, native::uid())? {
            return Ok(());
        }
        before = Some(identity(&base, end)?);
        let previous = before.as_ref().expect("actual proc identity");
        if previous.terminal() {
            return Ok(());
        }
        report.note_process()?;
        let table = match ReservationKernel::new().cold_reference_mounts(
            &PosixPath::try_new(&native::python_text(&base)).expect("filesystem points"),
            end,
        ) {
            Ok(table) => Some(IndexedMounts::new(table)),
            Err(ReservationKernelError::Observation(ObservationError::Io(error)))
                if error.kind() == io::ErrorKind::PermissionDenied =>
            {
                report.record(pid, ReferenceKind::Unknown(UnknownReference::MountMetadata))?;
                None
            }
            Err(ReservationKernelError::Observation(ObservationError::Io(error))) => {
                return Err(error.into());
            }
            Err(error) => return Err(StorageError::ColdKernel(Box::new(error))),
        };
        let mut observer = Observer {
            target,
            report,
            pid,
            table,
            end,
        };
        let sockets = observer.fds(&base, ignored)?;
        observer.unix(&base, &sockets)?;
        for link in [ReferenceLink::Cwd, ReferenceLink::Root, ReferenceLink::Exe] {
            observer.link(&base, link)?;
        }
        observer.maps(&base)?;
        need(
            identity(&base, end)?.start() == previous.start(),
            StorageFault::ColdReference,
        )
    })();
    match result {
        Err(error) if vanished(&error) => settle_vanished(&base, before.as_ref(), end),
        result => result,
    }
}
fn settle_vanished(
    base: &Path,
    before: Option<&ReferenceProcessIdentity>,
    end: Instant,
) -> Result<()> {
    if !base.try_exists()? {
        return Ok(());
    }
    match identity(base, end) {
        Ok(after) => need(
            after.terminal() && before.is_none_or(|before| before.start() == after.start()),
            StorageFault::ColdReference,
        ),
        Err(error) if vanished(&error) => need(!base.try_exists()?, StorageFault::ColdReference),
        Err(error) => Err(error),
    }
}
