//! Fixed Nix-store bytes in the host and selected init root. This returns file
//! identity DATA only. The real Q owner must still bind the actual engine,
//! incarnation, process, peer and current owner before authorizing any work.
pub(super) mod files;
#[cfg(test)]
mod tests;
use super::files::Descriptors;
use super::*;
use files::{Stamp, check_end, nix_path, open_image};
use reverie_contracts::resource_actor::CodeFile;
use reverie_core::decimal::UnsignedInteger;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    time::Instant,
};
pub(super) const MAX_CODE_FILE: u64 = 256 * 1024 * 1024;

#[derive(Default)]
pub struct ImmutableCodeObserver {
    close_uncertain: bool,
}
/// An observed guest inode, never a process, path, execution or owner grant.
pub struct ObservedCodeFile {
    device: u64,
    inode: u64,
}
impl ObservedCodeFile {
    pub fn identity(&self) -> [u64; 2] {
        [self.device, self.inode]
    }
}
impl ImmutableCodeObserver {
    /// Caller supplies installer-selected manifest DATA, not a wire-selected
    /// executable. Recheck the bound init before and after this whole operation.
    /// No namespace switch, exec, write, generic guest symlink or fallback open.
    pub fn observe_file(
        &mut self,
        init: &UnsignedInteger,
        code: &CodeFile,
        end: Instant,
    ) -> Result<ObservedCodeFile> {
        need(!self.close_uncertain, "BACKEND_CODE_CLOSE_UNCONFIRMED")?;
        need(
            init.to_u64()
                .is_some_and(|pid| pid > 1 && u32::try_from(pid).is_ok()),
            "WEBSITE_INIT_SELECTION",
        )?;
        need(code.bytes <= MAX_CODE_FILE, "IMMUTABLE_CODE_BINDING")?;
        let path = nix_path(&code.path)?;
        let mut files = Descriptors::default();
        let body = observe(&mut files, init, &path, code, end);
        files.finish(body, &mut self.close_uncertain)
    }
}
pub(super) fn read_open(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)
}
pub(super) fn observe(
    files: &mut Descriptors,
    init: &UnsignedInteger,
    path: &Path,
    code: &CodeFile,
    end: Instant,
) -> Result<ObservedCodeFile> {
    check_end(end)?;
    need(
        fs::canonicalize(path)? == path,
        "CANONICAL_HOST_CODE_REQUIRED",
    )?;
    let host = files.retain(read_open(path)?);
    let trusted = files.get(host).metadata()?;
    need(
        trusted.is_file()
            && trusted.uid() == 0
            && trusted.mode() & 0o222 == 0
            && trusted.len() == code.bytes,
        "IMMUTABLE_HOST_CODE_REQUIRED",
    )?;
    let root = files.retain(
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC)
            .open(format!("/proc/{}/root", init.as_str()))?,
    );
    let guest = files.retain(open_image(files.get(root), path)?);
    let actual = files.get(guest).metadata()?;
    let mapped_root = mapped_root_uid(files, init, end)?;
    let flags = nix::sys::statvfs::fstatvfs(files.get(guest))
        .map_err(io::Error::from)?
        .flags();
    need(
        actual.is_file()
            && actual.mode() & 0o222 == 0
            && actual.uid() == mapped_root
            && actual.len() == code.bytes
            && flags.contains(nix::sys::statvfs::FsFlags::ST_RDONLY),
        "PROTECTED_IMAGE_CODE_REQUIRED",
    )?;
    let before = [Stamp::of(&trusted), Stamp::of(&actual)];
    for index in [host, guest] {
        hash(files.get_mut(index), code, end)?;
    }
    need(
        Stamp::of(&files.get(host).metadata()?) == before[0]
            && Stamp::of(&files.get(guest).metadata()?) == before[1],
        "BACKEND_CODE_READ_CHANGED",
    )?;
    check_end(end)?;
    Ok(ObservedCodeFile {
        device: actual.dev(),
        inode: actual.ino(),
    })
}
pub(super) fn hash(file: &mut File, code: &CodeFile, end: Instant) -> Result<()> {
    let mut hasher = Sha256::new();
    let mut count = 0_u64;
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        check_end(end)?;
        let available = usize::try_from((MAX_CODE_FILE + 1 - count).min(buffer.len() as u64))
            .expect("bounded chunk");
        let read = file.read(&mut buffer[..available])?;
        if read == 0 {
            break;
        }
        count += read as u64;
        need(count <= MAX_CODE_FILE, "BACKEND_CODE_BOUND")?;
        hasher.update(&buffer[..read]);
    }
    need(
        count == code.bytes
            && JournalDigest::parse(&format!("{:x}", hasher.finalize())).expect("SHA256")
                == code.sha256,
        "BACKEND_CODE_BYTES_CHANGED",
    )
}
pub(super) fn mapped_root_uid(
    files: &mut Descriptors,
    init: &UnsignedInteger,
    end: Instant,
) -> Result<u32> {
    check_end(end)?;
    let index = files.retain(read_open(Path::new(&format!(
        "/proc/{}/uid_map",
        init.as_str()
    )))?);
    let mut bytes = Vec::new();
    files.get_mut(index).take(4097).read_to_end(&mut bytes)?;
    need(bytes.len() <= 4096, "UID_MAP_BOUND")?;
    let raw =
        std::str::from_utf8(&bytes).map_err(|_| WebsiteFactsError::Refused("UID_MAP_REQUIRED"))?;
    let rows: Vec<_> = raw
        .lines()
        .map(|line| {
            line.split_whitespace()
                .map(str::parse::<u64>)
                .collect::<std::result::Result<Vec<_>, _>>()
        })
        .collect::<std::result::Result<_, _>>()
        .map_err(|_| WebsiteFactsError::Refused("UID_MAP_REQUIRED"))?;
    need(
        (1..=64).contains(&rows.len()) && rows.iter().all(|row| row.len() == 3 && row[2] > 0),
        "UID_MAP_REQUIRED",
    )?;
    let roots: Vec<_> = rows.iter().filter(|row| row[0] == 0).collect();
    need(roots.len() == 1, "ROOT_UID_MAPPING_REQUIRED")?;
    check_end(end)?;
    u32::try_from(roots[0][1]).map_err(|_| WebsiteFactsError::Refused("ROOT_UID_MAPPING_REQUIRED"))
}
