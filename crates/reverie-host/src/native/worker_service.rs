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
pub(crate) fn retain_upgrade_package(source: &File, destination: &File) -> io::Result<()> {
    super::rename::noreplace(
        source,
        c"native-package",
        destination,
        c"previous-native-package",
    )
}
pub(crate) fn retain_upgrade_running(source: &File, destination: &File) -> io::Result<()> {
    super::rename::noreplace(source, c"native-running", destination, c"native-running")
}
pub(crate) fn retain_upgrade_failure(source: &File, destination: &File) -> io::Result<()> {
    super::rename::noreplace(source, c"native-failure", destination, c"native-failure")
}
pub(crate) fn retain_stopped_service_pending(
    source: &File,
    destination: &File,
    kind: crate::worker_service::RetainedServicePending,
) -> io::Result<()> {
    use crate::worker_service::RetainedServicePending;
    let leaf = match kind {
        RetainedServicePending::Stop => c"previous-stop-pending",
        RetainedServicePending::Image => c"previous-image-pending",
    };
    super::rename::noreplace(source, c"pending", destination, leaf)
}
