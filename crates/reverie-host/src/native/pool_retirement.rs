//! Fixed no-replace archival names selected only by the failed-installation
//! owner while its original stopped IMAGE and maintenance owners remain held.
use std::{fs::File, io};
pub(crate) fn archive_failed_pool_policies(source: &File, history: &File) -> io::Result<()> {
    super::rename::noreplace(source, c"policies", history, c"policies-before")
}
pub(crate) fn archive_failed_pool_control(source: &File, history: &File) -> io::Result<()> {
    super::rename::noreplace(source, c"control", history, c"control-before")
}
