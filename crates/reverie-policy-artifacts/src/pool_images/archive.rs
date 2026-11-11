//! Build-only bounded extraction from one held file, never a runtime executor.
use super::error::{Error, Result, combined, finalized, need};
use crate::output;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Seek},
    os::{
        fd::OwnedFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Instant,
};
const MAX_ARCHIVE: u64 = 512 * 1024 * 1024;
const MAX_LAYER: u64 = 512 * 1024 * 1024;
pub(super) const MAX_METADATA: usize = 65_536;
const TAR: Option<&str> = option_env!("REVERIE_FIXED_BUILD_GNUTAR");
const TIMEOUT: Option<&str> = option_env!("REVERIE_FIXED_BUILD_TIMEOUT");
const GZIP_PATH: Option<&str> = option_env!("REVERIE_FIXED_BUILD_GZIP_PATH");

#[derive(Eq, PartialEq)]
struct Stamp {
    device: u64,
    inode: u64,
    bytes: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}
fn stamp(m: &Metadata) -> Stamp {
    Stamp {
        device: m.dev(),
        inode: m.ino(),
        bytes: m.len(),
        modified: (m.mtime(), m.mtime_nsec()),
        changed: (m.ctime(), m.ctime_nsec()),
    }
}
struct Readback {
    bytes: Vec<u8>,
    hash: String,
    count: u64,
}
pub(super) struct Archive {
    file: Option<File>,
    path: PathBuf,
    before: Stamp,
    hash: String,
    end: Instant,
}
impl Archive {
    pub(super) fn open(path: &Path, end: Instant) -> Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        let observed = file.metadata().map_err(Error::from);
        let metadata = match observed {
            Ok(value) => value,
            Err(error) => return finalized(Err(error), output::close(file).map_err(Into::into)),
        };
        let mut owner = Self {
            file: Some(file),
            path: path.into(),
            before: stamp(&metadata),
            hash: String::new(),
            end,
        };
        let body = (|| {
            need(
                metadata.is_file() && metadata.len() > 0 && metadata.len() <= MAX_ARCHIVE,
                "POOL_IMAGE_ARCHIVE_BOUND",
            )?;
            owner.hash = owner.hash_original()?;
            owner.assert_stamp()
        })();
        match body {
            Ok(()) => Ok(owner),
            Err(error) => finalized(Err(error), owner.close()),
        }
    }
    fn original(&mut self) -> Result<&mut File> {
        self.file
            .as_mut()
            .ok_or(Error::Refused("POOL_IMAGE_ARCHIVE_CLOSED"))
    }
    fn assert_stamp(&self) -> Result<()> {
        let file = self
            .file
            .as_ref()
            .ok_or(Error::Refused("POOL_IMAGE_ARCHIVE_CLOSED"))?;
        need(
            stamp(&file.metadata()?) == self.before
                && stamp(&fs::symlink_metadata(&self.path)?) == self.before,
            "POOL_IMAGE_ARCHIVE_CHANGED",
        )
    }
    fn hash_original(&mut self) -> Result<String> {
        let end = self.end;
        let file = self.original()?;
        file.rewind()?;
        let result = read(file, MAX_ARCHIVE, false, end)?;
        need(
            result.count == self.before.bytes,
            "POOL_IMAGE_ARCHIVE_CHANGED",
        )?;
        Ok(result.hash)
    }
    pub(super) fn assert_current(&mut self) -> Result<()> {
        self.assert_stamp()?;
        need(
            self.hash_original()? == self.hash,
            "POOL_IMAGE_ARCHIVE_CHANGED",
        )?;
        self.assert_stamp()
    }
    pub(super) fn path(&self) -> Result<&str> {
        self.path
            .to_str()
            .ok_or(Error::Refused("POOL_IMAGE_PATH_UTF8"))
    }
    pub(super) fn digest(&self) -> &str {
        &self.hash
    }
    pub(super) fn bytes(&self) -> u64 {
        self.before.bytes
    }
    pub(super) fn metadata(&mut self, member: &str) -> Result<Vec<u8>> {
        Ok(self.extract(member, true)?.bytes)
    }
    pub(super) fn layer_digest(&mut self, member: &str) -> Result<String> {
        Ok(self.extract(member, false)?.hash)
    }
    pub(super) fn verify_program(
        &mut self,
        selected: &[String],
        path: &Path,
        digest: &str,
        bytes: u64,
    ) -> Result<()> {
        self.assert_stamp()?;
        let end = self.end;
        let file = self.original()?;
        file.rewind()?;
        super::program::verify(file, selected, path, digest, bytes, end)?;
        self.assert_current()
    }
    fn extract(&mut self, member: &str, metadata: bool) -> Result<Readback> {
        self.assert_stamp()?;
        let seconds = self
            .end
            .saturating_duration_since(Instant::now())
            .as_secs()
            .min(30);
        need(seconds > 0, "POOL_IMAGE_EXTRACTION_DEADLINE")?;
        let program = TAR.ok_or(Error::Refused("POOL_IMAGE_BUILD_TAR_UNCONFIGURED"))?;
        let timeout = TIMEOUT.ok_or(Error::Refused("POOL_IMAGE_BUILD_TIMEOUT_UNCONFIGURED"))?;
        let gzip = GZIP_PATH.ok_or(Error::Refused("POOL_IMAGE_BUILD_GZIP_UNCONFIGURED"))?;
        let file = self.original()?;
        file.rewind()?;
        let mut child = Command::new(timeout)
            .env_clear()
            .env("PATH", gzip)
            .env("LANG", "C")
            .env("LC_ALL", "C")
            .args([
                "--kill-after=1s",
                &format!("{seconds}s"),
                program,
                "-xzOf",
                "-",
                member,
            ])
            .stdin(Stdio::from(file.try_clone()?))
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or(Error::Refused("POOL_IMAGE_TAR_STDOUT"))?;
        let mut stdout = File::from(OwnedFd::from(stdout));
        let body = read(
            &mut stdout,
            if metadata {
                MAX_METADATA as u64
            } else {
                MAX_LAYER
            },
            metadata,
            self.end,
        );
        let body = finalized(body, output::close(stdout).map_err(Into::into));
        let joined = match child.wait() {
            Ok(status) => need(status.success(), "POOL_IMAGE_TAR_REFUSED"),
            Err(cause) => Err(Error::Wait {
                cause,
                _child: Box::new(child),
            }),
        };
        let body = combined(body, joined);
        combined(body, self.assert_stamp())
    }
    pub(super) fn close(&mut self) -> Result<()> {
        self.file
            .take()
            .map_or(Ok(()), |file| output::close(file).map_err(Into::into))
    }
}
fn read(reader: &mut impl Read, maximum: u64, keep: bool, end: Instant) -> Result<Readback> {
    let mut hash = Sha256::new();
    let mut count = 0_u64;
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 16_384];
    loop {
        need(Instant::now() < end, "POOL_IMAGE_READ_DEADLINE")?;
        let n = reader.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        count = count
            .checked_add(n as u64)
            .ok_or(Error::Refused("POOL_IMAGE_READ_BOUND"))?;
        need(count <= maximum, "POOL_IMAGE_READ_BOUND")?;
        hash.update(&buffer[..n]);
        if keep {
            bytes.extend_from_slice(&buffer[..n]);
        }
    }
    Ok(Readback {
        bytes,
        hash: format!("{:x}", hash.finalize()),
        count,
    })
}
