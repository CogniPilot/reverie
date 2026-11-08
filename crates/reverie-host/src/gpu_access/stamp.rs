use super::*;
use std::{fs, path::Path};
/// Exact `_stamp` eight-field DATA. A named signature is only an observation;
/// it is not an inode-conditional rename against a noncooperating same-UID actor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GpuFileStamp(native::PrivateFileStamp);
impl GpuFileStamp {
    pub fn observe(path: &Path) -> Result<Self> {
        Ok(Self::of(&fs::symlink_metadata(path)?))
    }
    pub fn observe_optional(path: &Path) -> Result<Option<Self>> {
        match fs::symlink_metadata(path) {
            Ok(info) => Ok(Some(Self::of(&info))),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
    pub(crate) fn of(info: &fs::Metadata) -> Self {
        Self(native::PrivateFileStamp::of(info))
    }
    pub(crate) fn from_native(stamp: native::PrivateFileStamp) -> Self {
        Self(stamp)
    }
    pub(crate) fn named(parent: &fs::File, name: &std::ffi::OsStr) -> Result<Self> {
        Ok(Self(native::PrivateFileStamp::named(parent, name)?))
    }
    pub(crate) fn private(&self, owner: u32) -> bool {
        self.0.private(owner)
    }
}
