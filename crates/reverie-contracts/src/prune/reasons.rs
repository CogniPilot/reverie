//! Stable r12 skip precedence. Report-only reasons are not candidate refusals.
use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    AnchorChanged,
    RepoUnbound,
    RegistryChanged,
    RegistryUntrusted,
    ProcUnreadable,
    LeaseUnknown,
    LeaseHeld,
    Reserved,
    BarrierBusy,
    OpenFile,
    Cwd,
    RecentWrite,
    ToolLock,
    Keep,
    Mount,
    SymlinkPath,
    WalkError,
    GitUnsafe,
    RegistryInvalid,
    NotIdle,
}

pub fn ordered_reasons(reasons: impl IntoIterator<Item = Reason>) -> Vec<Reason> {
    let mut reasons: Vec<_> = reasons.into_iter().collect();
    reasons.sort_unstable();
    reasons.dedup();
    reasons
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(i32)]
pub enum ExitCode {
    Ok = 0,
    Config = 2,
    LiveRefused = 3,
    Partial = 4,
    Busy = 5,
}
