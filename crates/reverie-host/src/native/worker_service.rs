//! Fixed worker-unit predecessor retention using the existing checked native
//! no-replace rename. No arbitrary target name or path is exposed.
use std::{fs::File, io};
pub(crate) fn retain_predecessor(source: &File, destination: &File) -> io::Result<()> {
    super::rename::noreplace(
        source,
        c"reverie-worker-broker.service",
        destination,
        c"previous-unit",
    )
}
pub(crate) fn retain_native_service_unit(source: &File, destination: &File) -> io::Result<()> {
    super::rename::noreplace(
        source,
        c"reverie-worker-broker.service",
        destination,
        c"rolled-back-native-unit",
    )
}
pub(crate) fn retain_native_service_environment(parent: &File) -> io::Result<()> {
    super::rename::noreplace(
        parent,
        c"environment",
        parent,
        c"rolled-back-native-environment",
    )
}
pub(crate) fn restore_previous_service_unit(source: &File, destination: &File) -> io::Result<()> {
    super::rename::noreplace(
        source,
        c"previous-unit",
        destination,
        c"reverie-worker-broker.service",
    )
}
