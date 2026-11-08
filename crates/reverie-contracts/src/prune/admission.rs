use super::{Config, Pass};
use serde::Deserialize;

/// Native observations supplied as data, never manufactured custody proof.
/// `canonical_path = None` includes failed or unreadable canonicalization.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct RootObservation {
    pub path: String,
    pub canonical_path: Option<String>,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub device: Option<(u64, u64)>,
    pub inode: Option<u64>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct MountObservation {
    pub point: String,
    pub root: String,
    pub source: String,
    pub fstype: String,
    pub device: (u64, u64),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RootAnchor {
    path: String,
    device: (u64, u64),
    inode: u64,
}
impl RootAnchor {
    pub fn path(&self) -> &str {
        &self.path
    }
    pub fn device(&self) -> (u64, u64) {
        self.device
    }
    pub fn inode(&self) -> u64 {
        self.inode
    }
    pub fn matches(&self, observed: &RootObservation) -> bool {
        observed.path == self.path
            && observed.is_directory
            && !observed.is_symlink
            && observed.canonical_path.as_deref() == Some(self.path.as_str())
            && observed.device == Some(self.device)
            && observed.inode == Some(self.inode)
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdmissionError {
    InvalidContext,
    MissingObservation,
    UnknownIdentity,
    NotCanonicalDirectory,
    MissingMount,
    NotMountPoint,
    NotFullFilesystem,
    IdentityMismatch,
    DeviceMismatch,
}

impl Config {
    /// AUTH-1 over supplied observations. Unknown facts refuse, and no partial
    /// anchor set is returned. AUTH-2 registry admission is a later boundary.
    /// Test-unbound is accepted only if this call also explicitly says test root.
    pub fn admit_roots(
        &self,
        pass: Pass,
        roots: &[RootObservation],
        mounts: Option<&[MountObservation]>,
        test_root: bool,
    ) -> Result<Vec<RootAnchor>, AdmissionError> {
        if !self.valid_context(test_root) {
            return Err(AdmissionError::InvalidContext);
        }
        let mut paths = vec![self.b_mount()];
        if pass.includes_checkouts() {
            paths.extend(self.checkout_roots().iter().map(String::as_str));
        }
        paths
            .into_iter()
            .map(|root| self.admit_root(root, roots, mounts, test_root))
            .collect()
    }
    fn admit_root(
        &self,
        path: &str,
        roots: &[RootObservation],
        mounts: Option<&[MountObservation]>,
        test_root: bool,
    ) -> Result<RootAnchor, AdmissionError> {
        let mut matching = roots.iter().filter(|r| r.path == path);
        let observed = matching.next().ok_or(AdmissionError::MissingObservation)?;
        if matching.next().is_some() {
            return Err(AdmissionError::MissingObservation);
        }
        if !observed.is_directory || observed.is_symlink {
            return Err(AdmissionError::NotCanonicalDirectory);
        }
        let device = observed.device.ok_or(AdmissionError::MissingObservation)?;
        let inode = observed.inode.ok_or(AdmissionError::MissingObservation)?;
        if !(test_root && self.test_unbound_ok()) {
            self.check_mount(path, observed, mounts)?;
        }
        Ok(RootAnchor {
            path: path.into(),
            device,
            inode,
        })
    }
    fn check_mount(
        &self,
        path: &str,
        observed: &RootObservation,
        mounts: Option<&[MountObservation]>,
    ) -> Result<(), AdmissionError> {
        let identity = self
            .root_identity(path)
            .ok_or(AdmissionError::UnknownIdentity)?;
        if !canonical(path) || observed.canonical_path.as_deref() != Some(path) {
            return Err(AdmissionError::NotCanonicalDirectory);
        }
        // Innermost containing mount, and last-listed wins among equal points.
        let mount = mounts
            .ok_or(AdmissionError::MissingMount)?
            .iter()
            .filter(|m| contains(&m.point, path))
            .max_by_key(|m| m.point.len())
            .ok_or(AdmissionError::MissingMount)?;
        if path == self.b_mount() {
            if mount.point != path {
                return Err(AdmissionError::NotMountPoint);
            }
            if identity.mount_root != "/" || mount.root != "/" {
                return Err(AdmissionError::NotFullFilesystem);
            }
        }
        if (
            mount.source.as_str(),
            mount.fstype.as_str(),
            mount.root.as_str(),
        ) != (&identity.source, &identity.fstype, &identity.mount_root)
        {
            return Err(AdmissionError::IdentityMismatch);
        }
        if observed.device != Some(mount.device) {
            return Err(AdmissionError::DeviceMismatch);
        }
        Ok(())
    }
}
fn canonical(path: &str) -> bool {
    path == "/"
        || (path.starts_with('/') && path[1..].split('/').all(|s| !matches!(s, "" | "." | "..")))
}
fn contains(base: &str, path: &str) -> bool {
    canonical(base)
        && (base == "/"
            || path == base
            || path.strip_prefix(base).is_some_and(|s| s.starts_with('/')))
}
