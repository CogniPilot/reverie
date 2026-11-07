//! The legacy Office plan capability's exact private directory chain. No
//! request chooses a host path; checked IDs only select the existing leaf.
use super::{close, open_at, read_snapshot};
use crate::observation::{ObservationError, ObservationFault, Result, finalized, need};
use reverie_contracts::office_plan::PlanDecision;
use reverie_core::ids::ProfileSessionId;
use std::{
    ffi::OsStr,
    fs::File,
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::{Component, Path},
};
pub(crate) fn office_plan_capability(
    root: &Path,
    session: &ProfileSessionId,
    decision: &PlanDecision,
) -> Result<Vec<u8>> {
    need(
        root.is_absolute()
            && root
                .components()
                .all(|part| matches!(part, Component::RootDir | Component::Normal(_))),
        ObservationFault::CanonicalPath,
    )?;
    let mut held = Vec::new();
    let result = read(root, session, decision, &mut held);
    let mut result = result;
    for file in held.into_iter().rev() {
        result = finalized(result, close(file));
    }
    result
}
fn read(
    root: &Path,
    session: &ProfileSessionId,
    decision: &PlanDecision,
    held: &mut Vec<File>,
) -> Result<Vec<u8>> {
    held.push(open_at(
        libc::AT_FDCWD,
        OsStr::new("/"),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?);
    for component in root.components().skip(1) {
        directory(held, component.as_os_str(), false)?;
    }
    for component in ["console", "plan-request-capabilities", session.as_str()] {
        directory(held, OsStr::new(component), true)?;
    }
    let name = format!("{}.json", decision.request_id());
    let parent = held
        .last()
        .ok_or(ObservationError::Refused(ObservationFault::ArtifactCustody))?;
    let mut file = open_at(
        parent.as_raw_fd(),
        OsStr::new(&name),
        libc::O_RDONLY | libc::O_NONBLOCK,
    )?;
    let named = root
        .join("console/plan-request-capabilities")
        .join(session.as_str())
        .join(name);
    let result = read_snapshot(&mut file, &named, 4096, |metadata| {
        metadata.uid() == super::uid() && metadata.mode() & 0o077 == 0 && metadata.nlink() == 1
    })
    .map(|snapshot| snapshot.bytes);
    finalized(result, close(file))
}
fn directory(held: &mut Vec<File>, name: &OsStr, private: bool) -> Result<()> {
    let parent = held
        .last()
        .ok_or(ObservationError::Refused(ObservationFault::ArtifactCustody))?;
    let child = open_at(parent.as_raw_fd(), name, libc::O_RDONLY | libc::O_DIRECTORY)?;
    held.push(child);
    if private {
        let metadata = held
            .last()
            .ok_or(ObservationError::Refused(ObservationFault::ArtifactCustody))?
            .metadata()?;
        need(
            metadata.uid() == super::uid() && metadata.mode() & 0o077 == 0,
            ObservationFault::ArtifactCustody,
        )?;
    }
    Ok(())
}
