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
