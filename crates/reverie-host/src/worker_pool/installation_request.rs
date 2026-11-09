//! Fixed OS-operator nomination snapshot. This is data, never website consent
//! or permission to activate a controller or launch a worker.
use super::*;
use crate::native;
use reverie_contracts::resource_actor::PoolInstallationRequestData;
use std::{
    fs,
    os::{fd::AsRawFd, unix::fs::MetadataExt},
    path::PathBuf,
};

/// Read only the registered account's private, fixed installation request.
/// Environment HOME, command-line paths and wire requests cannot redirect it.
pub fn load_os_pool_installation_request() -> Result<PoolInstallationRequestData> {
    let root = native::python_path(&native::home_directory(None)?)?.join("reverie");
    read_request(root)
}

fn read_request(root: PathBuf) -> Result<PoolInstallationRequestData> {
    let mut owner = RequestSource {
        root,
        directories: Vec::new(),
    };
    let body = owner.read();
    finalized(body, owner.close())
}

struct RequestSource {
    root: PathBuf,
    directories: Vec<fs::File>,
}
impl RequestSource {
    fn read(&mut self) -> Result<PoolInstallationRequestData> {
        need(
            fs::canonicalize(&self.root)? == self.root,
            "POOL_REQUEST_ROOT",
        )?;
        self.directories.push(native::open_at(
            libc::AT_FDCWD,
            self.root.as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?);
        self.assert_directory(0)?;
        self.directories.push(native::open_at(
            self.directories[0].as_raw_fd(),
            std::ffi::OsStr::new("worker-pool"),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?);
        self.assert_directory(1)?;
        let path = PathBuf::from(format!(
            "/proc/self/fd/{}/registration-request.json",
            self.directories[1].as_raw_fd()
        ));
        let raw = native::observe(&path, 65_536, |m| {
            m.uid() == native::uid()
                && m.gid() == nix::unistd::getegid().as_raw()
                && m.mode() & 0o7777 == 0o600
                && m.nlink() == 1
        })?;
        self.assert_directory(0)?;
        self.assert_directory(1)?;
        let request = PoolInstallationRequestData::decode(&raw)
            .map_err(|_| PoolError::Refused("POOL_REQUEST_INVALID"))?;
        need(
            self.root.to_str() == Some(request.policy().instance_root.as_str()),
            "POOL_REQUEST_INSTANCE",
        )?;
        need(
            request.policy().broker_uid == native::uid()
                && request.policy().broker_gid == nix::unistd::getegid().as_raw(),
            "POOL_REQUEST_BROKER_IDS",
        )?;
        Ok(request)
    }
    fn assert_directory(&self, index: usize) -> Result<()> {
        let held = self.directories[index].metadata()?;
        let named = if index == 0 {
            fs::symlink_metadata(&self.root)?
        } else {
            fs::symlink_metadata(format!(
                "/proc/self/fd/{}/worker-pool",
                self.directories[0].as_raw_fd()
            ))?
        };
        need(
            [&held, &named].iter().all(|m| {
                m.is_dir()
                    && m.uid() == native::uid()
                    && m.gid() == nix::unistd::getegid().as_raw()
                    && m.mode() & 0o7777 == 0o700
            }) && [held.dev(), held.ino()] == [named.dev(), named.ino()],
            "POOL_REQUEST_DIRECTORY_CUSTODY",
        )
    }
    fn close(&mut self) -> Result<()> {
        let mut result = Ok(());
        while let Some(file) = self.directories.pop() {
            result = finalized(result, native::close(file).map_err(Into::into));
        }
        result
    }
}

#[cfg(test)]
mod tests;
