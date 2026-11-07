use super::{Result, SnapshotError, deadline, directory::Directory, process::Tools, require};
use crate::native;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    os::{
        fd::AsRawFd,
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

const MAX_ENTRIES: usize = 200_000;
const MAX_MANIFEST_BYTES: usize = 64 << 20;
#[derive(Clone, Debug, Eq, PartialEq)]
enum Content {
    Directory,
    Regular(String),
    Symlink(Vec<u8>),
}
#[derive(Clone, Debug, Eq, PartialEq)]
struct Entry {
    relative: PathBuf,
    content: Content,
    mode: u32,
    uid: u32,
    gid: u32,
    size: u64,
    mtime: (i64, i64),
    attrs: Vec<u8>,
    acl: Vec<u8>,
    hardlink: Option<PathBuf>,
    source: native::Stamp,
    inode: (u64, u64),
    links: u64,
}
impl Entry {
    fn same_restored(&self, other: &Self) -> bool {
        self.relative == other.relative
            && self.content == other.content
            && self.mode == other.mode
            && self.uid == other.uid
            && self.gid == other.gid
            && self.size == other.size
            && self.mtime == other.mtime
            && self.attrs == other.attrs
            && self.acl == other.acl
            && self.hardlink == other.hardlink
    }
}
pub(super) struct Manifest {
    entries: Vec<Entry>,
    bytes: u64,
    attribute_bytes: usize,
}
impl Manifest {
    pub(super) fn capture(
        root: &Arc<Directory>,
        output: &Arc<Directory>,
        tools: &Tools,
        end: Instant,
    ) -> Result<Self> {
        root.check()?;
        let mut manifest = Self {
            entries: Vec::new(),
            bytes: 0,
            attribute_bytes: 0,
        };
        manifest.walk(root, output, tools, Path::new("console"), end)?;
        manifest.entries.sort_by(|a, b| a.relative.cmp(&b.relative));
        manifest.hardlinks()?;
        root.check()?;
        Ok(manifest)
    }
    fn walk(
        &mut self,
        root: &Arc<Directory>,
        output: &Arc<Directory>,
        tools: &Tools,
        relative: &Path,
        end: Instant,
    ) -> Result<()> {
        deadline(end)?;
        require(relative.components().count() <= 128, "SNAPSHOT_DEPTH_BOUND")?;
        require(self.entries.len() < MAX_ENTRIES, "SNAPSHOT_ENTRY_BOUND")?;
        let name = Path::new(
            relative
                .file_name()
                .ok_or_else(|| SnapshotError::refused("SNAPSHOT_ENTRY_NAME"))?,
        );
        let path = root.fd_path().join(name);
        let info = fs::symlink_metadata(&path)?;
        let before = native::Stamp::of(&info);
        let (attrs, acl) = tools.attributes(root, output, name, info.file_type(), end)?;
        self.attribute_bytes = self
            .attribute_bytes
            .checked_add(attrs.len())
            .and_then(|n| n.checked_add(acl.len()))
            .and_then(|n| n.checked_add(relative.as_os_str().as_bytes().len()))
            .ok_or_else(|| SnapshotError::refused("SNAPSHOT_MANIFEST_BOUND"))?;
        require(
            self.attribute_bytes <= MAX_MANIFEST_BYTES,
            "SNAPSHOT_MANIFEST_BOUND",
        )?;
        let content = self.content(root, name, &info, end)?;
        let size = if info.is_file() { info.len() } else { 0 };
        self.bytes = self
            .bytes
            .checked_add(size)
            .ok_or_else(|| SnapshotError::refused("SNAPSHOT_SIZE_BOUND"))?;
        self.entries.push(Entry {
            relative: relative.to_path_buf(),
            content,
            mode: info.mode(),
            uid: info.uid(),
            gid: info.gid(),
            size,
            mtime: (info.mtime(), info.mtime_nsec()),
            attrs,
            acl,
            hardlink: None,
            source: before.clone(),
            inode: (info.dev(), info.ino()),
            links: info.nlink(),
        });
        if info.is_dir() {
            self.children(root, output, tools, relative, end)?;
        }
        require(
            native::Stamp::of(&fs::symlink_metadata(&path)?) == before,
            "SNAPSHOT_SOURCE_CHANGED",
        )
    }
    fn content(
        &self,
        root: &Directory,
        relative: &Path,
        info: &fs::Metadata,
        end: Instant,
    ) -> Result<Content> {
        if info.is_dir() {
            return Ok(Content::Directory);
        }
        if info.is_symlink() {
            return Ok(Content::Symlink(
                fs::read_link(root.fd_path().join(relative))?
                    .as_os_str()
                    .as_bytes()
                    .to_vec(),
            ));
        }
        require(info.is_file(), "SNAPSHOT_UNSUPPORTED_FILE_TYPE")?;
        let file = native::open_at(
            root.file().as_raw_fd(),
            relative.as_os_str(),
            libc::O_RDONLY | libc::O_NONBLOCK,
        )?;
        let result = (|| {
            require(
                native::Stamp::of(&file.metadata()?) == native::Stamp::of(info),
                "SNAPSHOT_SOURCE_CHANGED",
            )?;
            let digest = file_digest(&file, end)?;
            require(
                native::Stamp::of(&file.metadata()?) == native::Stamp::of(info),
                "SNAPSHOT_SOURCE_CHANGED",
            )?;
            Ok(Content::Regular(digest))
        })();
        super::combine(result, native::close(file).map_err(Into::into))
    }
    fn children(
        &mut self,
        root: &Arc<Directory>,
        output: &Arc<Directory>,
        tools: &Tools,
        relative: &Path,
        end: Instant,
    ) -> Result<()> {
        let child = Arc::new(
            root.child(Path::new(
                relative
                    .file_name()
                    .ok_or_else(|| SnapshotError::refused("SNAPSHOT_ENTRY_NAME"))?,
            ))?,
        );
        let mut names = fs::read_dir(child.fd_path())?
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect::<std::io::Result<Vec<_>>>()?;
        names.sort();
        require(
            names.len() <= MAX_ENTRIES.saturating_sub(self.entries.len()),
            "SNAPSHOT_ENTRY_BOUND",
        )?;
        let result = (|| {
            for name in names {
                self.walk(&child, output, tools, &relative.join(name), end)?;
            }
            child.check()
        })();
        super::combine(result, super::close_directory(child))
    }
    fn hardlinks(&mut self) -> Result<()> {
        let mut groups: BTreeMap<(u64, u64), Vec<usize>> = BTreeMap::new();
        for (index, entry) in self.entries.iter().enumerate() {
            if !matches!(entry.content, Content::Directory) {
                groups.entry(entry.inode).or_default().push(index);
            }
        }
        for indices in groups.values() {
            let first = &self.entries[indices[0]];
            // A link outside console is not silently promoted into rollback
            // coverage. Its external identity cannot be restored from this copy.
            require(
                first.links == indices.len() as u64,
                "SNAPSHOT_EXTERNAL_HARDLINK",
            )?;
            if indices.len() <= 1 {
                continue;
            }
            let first_path = first.relative.clone();
            for index in indices {
                self.entries[*index].hardlink = Some(first_path.clone());
            }
        }
        Ok(())
    }
    pub(super) fn same_source(&self, other: &Self) -> bool {
        self.entries == other.entries
    }
    pub(super) fn same_restored(&self, other: &Self) -> bool {
        self.entries.len() == other.entries.len()
            && self
                .entries
                .iter()
                .zip(&other.entries)
                .all(|(a, b)| a.same_restored(b))
    }
    pub(super) fn entry_count(&self) -> usize {
        self.entries.len()
    }
    pub(super) fn regular_bytes(&self) -> u64 {
        self.bytes
    }
    pub(super) fn archive_limit(&self) -> Result<u64> {
        let bound = self
            .bytes
            .checked_add(self.attribute_bytes as u64 * 2)
            .and_then(|n| n.checked_add(self.entries.len() as u64 * 32_768))
            .and_then(|n| n.checked_add(1 << 20))
            .ok_or_else(|| SnapshotError::refused("SNAPSHOT_ARCHIVE_BOUND"))?;
        require(bound <= 128 << 30, "SNAPSHOT_ARCHIVE_BOUND")?;
        Ok(bound)
    }
    pub(super) fn digest(&self) -> String {
        let mut digest = Sha256::new();
        digest.update(b"reverie-console-snapshot-manifest-v1\0");
        for entry in &self.entries {
            for bytes in [
                entry.relative.as_os_str().as_bytes(),
                entry.attrs.as_slice(),
                entry.acl.as_slice(),
            ] {
                digest.update((bytes.len() as u64).to_le_bytes());
                digest.update(bytes);
            }
            digest.update(entry.mode.to_le_bytes());
            digest.update(entry.uid.to_le_bytes());
            digest.update(entry.gid.to_le_bytes());
            digest.update(entry.size.to_le_bytes());
            digest.update(entry.mtime.0.to_le_bytes());
            digest.update(entry.mtime.1.to_le_bytes());
            let content = match &entry.content {
                Content::Directory => vec![0],
                Content::Regular(hash) => [vec![1], hash.as_bytes().to_vec()].concat(),
                Content::Symlink(target) => [vec![2], target.clone()].concat(),
            };
            digest.update((content.len() as u64).to_le_bytes());
            digest.update(content);
            let link = entry
                .hardlink
                .as_deref()
                .map(|path| path.as_os_str().as_bytes())
                .unwrap_or_default();
            digest.update((link.len() as u64).to_le_bytes());
            digest.update(link);
        }
        format!("{:x}", digest.finalize())
    }
}
pub(super) fn file_digest(file: &File, end: Instant) -> Result<String> {
    let mut file = file.try_clone()?;
    let result = (|| {
        file.seek(SeekFrom::Start(0))?;
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 65_536];
        loop {
            deadline(end)?;
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        Ok(format!("{:x}", digest.finalize()))
    })();
    super::combine(result, native::close(file).map_err(Into::into))
}
