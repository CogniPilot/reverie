//! Explicit Docker owning fixture. Never selected by the ordinary test gate.
mod docker;
mod fixture;
use super::*;

#[test]
#[ignore = "requires reviewed owned Docker fixture and exact immutable image; no company effects"]
fn actual_implicit_parent_and_confined_controller_namespace() {
    if std::env::var_os("REVERIE_POOL_CONTEXT_CHILD").as_deref() == Some(std::ffi::OsStr::new("1"))
    {
        fixture::probe_child();
    } else {
        fixture::run_parent();
    }
}
