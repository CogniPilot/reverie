//! The only followed magic link is the fixed kernel /proc/PID/root. Every
//! component beneath its retained FD must be a real directory, never a symlink.
use super::*;
use std::ffi::OsString;

pub(super) struct Inside {
    names: Vec<OsString>,
    files: Vec<File>,
    directory: bool,
}
fn root(pid: u64) -> Result<File> {
    open(
        Path::new(&format!("/proc/{pid}/root")),
        OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| DeploymentError::new(BIND))
}
fn walk(mut files: Vec<File>, names: &[OsString], directory: bool) -> Result<Vec<File>> {
    let result = (|| {
        for (index, name) in names.iter().enumerate() {
            let parent = files.last().ok_or_else(|| DeploymentError::new(BIND))?;
            let directory = if directory || index + 1 < names.len() {
                OFlag::O_DIRECTORY
            } else {
                OFlag::empty()
            };
            let file = openat(
                parent,
                Path::new(name),
                OFlag::O_PATH | directory | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map(File::from)
            .map_err(|_| DeploymentError::new(BIND))?;
            files.push(file);
        }
        Ok(())
    })();
    match result {
        Ok(()) => Ok(files),
        Err(error) => DeploymentError::finalized(Err(error), close_all(files)),
    }
}
impl Inside {
    pub(super) fn capture(pid: u64, destination: &str, directory: bool) -> Result<Self> {
        let path = Path::new(destination);
        require(
            path.is_absolute() && !destination.as_bytes().iter().any(|b| b.is_ascii_control()),
            BIND,
        )?;
        let mut names = Vec::new();
        for component in path.components() {
            match component {
                Component::RootDir => (),
                Component::Normal(name) => names.push(name.to_os_string()),
                _ => return Err(DeploymentError::new(BIND)),
            }
        }
        require(!names.is_empty() && names.len() <= 64, BIND)?;
        let files = walk(vec![root(pid)?], &names, directory)?;
        Ok(Self {
            names,
            files,
            directory,
        })
    }
    pub(super) fn verify(&self, pid: u64, expected: &Metadata) -> Result<()> {
        let fresh = walk(vec![root(pid)?], &self.names, self.directory)?;
        let result = (|| {
            require(fresh.len() == self.files.len(), BIND)?;
            for (old, now) in self.files.iter().zip(&fresh) {
                require(same(&old.metadata()?, &now.metadata()?), BIND)?;
            }
            let leaf = fresh.last().ok_or_else(|| DeploymentError::new(BIND))?;
            require(same(&leaf.metadata()?, expected), BIND)
        })();
        DeploymentError::finalized(result, close_all(fresh))
    }
    pub(super) fn close(self) -> Result<()> {
        close_all(self.files)
    }
}
