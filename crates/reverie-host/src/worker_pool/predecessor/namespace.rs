use super::*;
use native::{PrivateFileStamp, private_goal};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::{self, File, Metadata},
    io::Read,
    os::{
        fd::AsRawFd,
        unix::fs::{FileTypeExt, MetadataExt},
    },
    path::PathBuf,
};

const SOCKET: &str = "controller.sock";

#[derive(Default)]
pub(super) struct Namespace {
    root: Option<File>,
    policies: Option<File>,
    control: Option<File>,
    birth_file: Option<File>,
    birth_stamp: Option<PrivateFileStamp>,
    birth: Option<ControllerBirthV2>,
    socket: Option<File>,
    socket_stamp: Option<PrivateFileStamp>,
}

impl Namespace {
    pub(super) fn capture(&mut self, policy: &WorkerPoolPolicy, digest: &str) -> Result<()> {
        let root = Path::new(&policy.instance_root).join("worker-pool");
        reverie_store::storage_identity::canonical(&root)
            .map_err(|_| PoolError::Refused("WORKER_POOL_PREDECESSOR_NAMESPACE_PATH"))?;
        self.root = Some(native::open_at(
            libc::AT_FDCWD,
            root.as_os_str(),
            directory_flags(),
        )?);
        let parent = self.root().as_raw_fd();
        self.policies = Some(native::open_at(
            parent,
            OsStr::new("policies"),
            directory_flags(),
        )?);
        self.control = Some(native::open_at(
            parent,
            OsStr::new("control"),
            directory_flags(),
        )?);
        self.assert_directories(policy)?;
        self.capture_birth(policy, digest)?;
        self.capture_socket(policy.broker_gid)?;
        self.assert_current(policy, digest)
    }

    fn capture_birth(&mut self, policy: &WorkerPoolPolicy, digest: &str) -> Result<()> {
        let name = format!("{digest}.json");
        self.birth_file = Some(native::open_at(
            self.policies().as_raw_fd(),
            OsStr::new(&name),
            libc::O_RDONLY | libc::O_NONBLOCK,
        )?);
        let file = self.birth_file.as_ref().expect("retained birth descriptor");
        let info = file.metadata()?;
        need(
            info.is_file()
                && info.uid() == policy.broker_uid
                && info.gid() == policy.broker_gid
                && info.mode() & 0o7777 == 0o440
                && info.nlink() == 1
                && (1..=65_536).contains(&info.len()),
            "WORKER_POOL_PREDECESSOR_BIRTH_CUSTODY",
        )?;
        self.birth_stamp = Some(PrivateFileStamp::of(&info));
        let mut raw = Vec::new();
        file.take(65_537).read_to_end(&mut raw)?;
        let invalid = |_| PoolError::Refused("WORKER_POOL_PREDECESSOR_BIRTH_DATA");
        let birth = ControllerBirthV2::decode(&raw).map_err(invalid)?;
        need(
            birth.policy() == policy
                && raw.len() as u64 == info.len()
                && birth.encode().map_err(invalid)? == raw
                && format!("{:x}", Sha256::digest(&raw)) == digest,
            "WORKER_POOL_PREDECESSOR_BIRTH_CHANGED",
        )?;
        self.birth = Some(birth);
        Ok(())
    }

    fn capture_socket(&mut self, gid: u32) -> Result<()> {
        match native::open_at(self.control().as_raw_fd(), OsStr::new(SOCKET), libc::O_PATH) {
            Ok(file) => self.socket = Some(file),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        }
        let info = self
            .socket
            .as_ref()
            .expect("retained socket descriptor")
            .metadata()?;
        need(
            valid_socket(&info, gid),
            "WORKER_POOL_PREDECESSOR_SOCKET_CUSTODY",
        )?;
        self.socket_stamp = Some(PrivateFileStamp::of(&info));
        Ok(())
    }

    pub(super) fn assert_current(&self, policy: &WorkerPoolPolicy, digest: &str) -> Result<()> {
        self.assert_directories(policy)?;
        let name = format!("{digest}.json");
        let birth = self.birth_file.as_ref().expect("retained original birth");
        let info = birth.metadata()?;
        need(
            info.gid() == policy.broker_gid
                && self.birth_stamp.as_ref() == Some(&PrivateFileStamp::of(&info))
                && self.birth_stamp.as_ref()
                    == Some(&PrivateFileStamp::named(
                        self.policies(),
                        OsStr::new(&name),
                    )?),
            "WORKER_POOL_PREDECESSOR_BIRTH_CHANGED",
        )?;
        self.assert_socket_current(policy.broker_gid)
    }

    fn assert_directories(&self, policy: &WorkerPoolPolicy) -> Result<()> {
        let root = Path::new(&policy.instance_root).join("worker-pool");
        let root_metadata = fs::symlink_metadata(root)?;
        assert_directory(self.root(), &root_metadata, policy, 0o700)?;
        for (name, file, mode) in [
            ("policies", self.policies(), 0o750),
            ("control", self.control(), 0o770),
        ] {
            let named = fs::symlink_metadata(fd_child(self.root(), name))?;
            assert_directory(file, &named, policy, mode)?;
        }
        Ok(())
    }

    fn assert_socket_current(&self, gid: u32) -> Result<()> {
        let named = fs::symlink_metadata(fd_child(self.control(), SOCKET));
        match (&self.socket, named) {
            (None, Err(error)) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            (Some(file), Ok(named)) => {
                let held = file.metadata()?;
                need(
                    valid_socket(&held, gid)
                        && valid_socket(&named, gid)
                        && self.socket_stamp.as_ref() == Some(&PrivateFileStamp::of(&held))
                        && self.socket_stamp.as_ref() == Some(&PrivateFileStamp::of(&named)),
                    "WORKER_POOL_PREDECESSOR_SOCKET_CHANGED",
                )
            }
            (_, Err(error)) if error.kind() != io::ErrorKind::NotFound => Err(error.into()),
            _ => Err(PoolError::Refused("WORKER_POOL_PREDECESSOR_SOCKET_CHANGED")),
        }
    }

    pub(super) fn birth(&self) -> &ControllerBirthV2 {
        self.birth.as_ref().expect("qualified original birth")
    }
    pub(super) fn has_socket(&self) -> bool {
        self.socket_stamp.is_some()
    }
    fn root(&self) -> &File {
        self.root.as_ref().expect("retained original root")
    }
    fn policies(&self) -> &File {
        self.policies.as_ref().expect("retained original policies")
    }
    fn control(&self) -> &File {
        self.control.as_ref().expect("retained original control")
    }

    pub(super) fn close(&mut self) -> Result<()> {
        let mut result = Ok(());
        for fd in [
            &mut self.socket,
            &mut self.birth_file,
            &mut self.control,
            &mut self.policies,
            &mut self.root,
        ] {
            if let Some(file) = fd.take() {
                result = finalized(result, native::close(file).map_err(PoolError::from));
            }
        }
        result
    }
}

impl Drop for Namespace {
    fn drop(&mut self) {
        std::mem::forget((
            self.socket.take(),
            self.birth_file.take(),
            self.control.take(),
            self.policies.take(),
            self.root.take(),
        ));
    }
}

fn directory_flags() -> i32 {
    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NONBLOCK
}

fn fd_child(parent: &File, name: &str) -> PathBuf {
    PathBuf::from(format!("/proc/self/fd/{}/{name}", parent.as_raw_fd()))
}

fn assert_directory(
    file: &File,
    named: &Metadata,
    policy: &WorkerPoolPolicy,
    mode: u32,
) -> Result<()> {
    let held = file.metadata()?;
    need(
        held.is_dir()
            && held.uid() == policy.broker_uid
            && held.gid() == policy.broker_gid
            && held.mode() & 0o7777 == mode
            && private_goal::identity(&held) == private_goal::identity(named),
        "WORKER_POOL_PREDECESSOR_DIRECTORY_CHANGED",
    )
}

fn valid_socket(info: &Metadata, gid: u32) -> bool {
    info.file_type().is_socket()
        && info.uid() == 0
        && info.gid() == gid
        && info.mode() & 0o7777 == 0o660
        && info.nlink() == 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_socket_observation_refuses_a_rebound_name_without_removing_it() {
        let path =
            std::env::temp_dir().join(format!("reverie-predecessor-socket-{}", std::process::id()));
        fs::create_dir(&path).unwrap();
        let mut namespace = Namespace::default();
        namespace.control =
            Some(native::open_at(libc::AT_FDCWD, path.as_os_str(), directory_flags()).unwrap());
        let gid = nix::unistd::getegid().as_raw();
        namespace.capture_socket(gid).unwrap();
        namespace.assert_socket_current(gid).unwrap();
        let leaf = path.join(SOCKET);
        fs::write(&leaf, b"original contents").unwrap();
        assert_eq!(
            namespace.assert_socket_current(gid).unwrap_err().code(),
            "WORKER_POOL_PREDECESSOR_SOCKET_CHANGED"
        );
        assert_eq!(
            namespace.capture_socket(gid).unwrap_err().code(),
            "WORKER_POOL_PREDECESSOR_SOCKET_CUSTODY"
        );
        namespace.close().unwrap();
        assert_eq!(fs::read(&leaf).unwrap(), b"original contents");
        fs::remove_dir_all(path).unwrap();
    }
}
