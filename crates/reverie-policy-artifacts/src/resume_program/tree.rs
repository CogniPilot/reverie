//! Complete immutable console observation. Root directory ownership is retained;
//! all inventory/metadata/link observations are rechecked before data escapes.
use crate::{build_input as input, output};
use input::{Result, need};
use reverie_contracts::worker_resume::{MAX_PROGRAM_ENTRIES, ResumeProgramBuild};
use reverie_core::{PythonText, posix_text};
use std::{
    ffi::OsString,
    fs::{self, File, Metadata, OpenOptions},
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    time::Instant,
};

#[derive(Clone, Copy, Eq, PartialEq)]
struct Stamp {
    device: u64,
    inode: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    bytes: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}
fn stamp(m: &Metadata) -> Stamp {
    Stamp {
        device: m.dev(),
        inode: m.ino(),
        mode: m.mode(),
        uid: m.uid(),
        gid: m.gid(),
        bytes: m.len(),
        modified: (m.mtime(), m.mtime_nsec()),
        changed: (m.ctime(), m.ctime_nsec()),
    }
}
enum Details {
    File,
    Directory(Vec<OsString>),
    Link { raw: PathBuf, resolved: PathBuf },
}
struct Snapshot {
    path: PathBuf,
    before: Stamp,
    details: Details,
}
pub(super) struct Tree {
    root: PathBuf,
    file: Option<File>,
    uid: u32,
    before: Option<Stamp>,
    snapshots: Vec<Snapshot>,
    end: Instant,
}
pub(super) fn with_tree<T>(
    root: &Path,
    end: Instant,
    body: impl FnOnce(&mut Tree) -> Result<T>,
) -> Result<T> {
    need(
        root.is_absolute()
            && root.starts_with("/nix/store")
            && root.canonicalize()?.as_os_str() == root.as_os_str(),
        "RESUME_CONSOLE_OUTPUT",
    )?;
    let store = fs::metadata("/nix/store")?;
    need(
        store.is_dir() && store.uid() == fs::metadata("/")?.uid(),
        "RESUME_BUILD_ROOT_STORE_OWNER",
    )?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)?;
    let mut tree = Tree {
        root: root.into(),
        file: Some(file),
        uid: store.uid(),
        before: None,
        snapshots: Vec::new(),
        end,
    };
    let result = (|| {
        let metadata = tree.file.as_ref().ok_or("RESUME_ROOT_CLOSED")?.metadata()?;
        tree.readonly_directory(&metadata)?;
        tree.before = Some(stamp(&metadata));
        body(&mut tree)
    })();
    let close = tree
        .file
        .take()
        .map_or(Ok(()), |file| output::close(file).map_err(Into::into));
    input::combine(result, close)
}
impl Tree {
    pub(super) fn node(&mut self, path: &Path, before: &Metadata) -> Result<()> {
        need(
            stamp(&fs::symlink_metadata(path)?) == stamp(before),
            "RESUME_NODE_CHANGED",
        )?;
        self.snapshots.push(Snapshot {
            path: path.into(),
            before: stamp(before),
            details: Details::File,
        });
        Ok(())
    }
    pub(super) fn observe(&mut self, graph: &mut ResumeProgramBuild) -> Result<()> {
        let root_stamp = self.before.ok_or("RESUME_ROOT_UNVALIDATED")?;
        graph.directory(input::text(&self.root)?)?;
        let mut pending = vec![(self.root.clone(), root_stamp)];
        while let Some((directory, before)) = pending.pop() {
            self.deadline()?;
            let metadata = fs::symlink_metadata(&directory)?;
            need(
                stamp(&metadata) == before,
                "RESUME_PROGRAM_DIRECTORY_CHANGED",
            )?;
            self.readonly_directory(&metadata)?;
            let names = children(&directory, self.end)?;
            for name in &names {
                self.entry(&directory.join(name), graph, &mut pending)?;
            }
            self.snapshots.push(Snapshot {
                path: directory,
                before,
                details: Details::Directory(names),
            });
        }
        Ok(())
    }
    fn entry(
        &mut self,
        path: &Path,
        graph: &mut ResumeProgramBuild,
        pending: &mut Vec<(PathBuf, Stamp)>,
    ) -> Result<()> {
        self.deadline()?;
        let metadata = fs::symlink_metadata(path)?;
        let before = stamp(&metadata);
        if metadata.file_type().is_symlink() {
            let raw = fs::read_link(path)?;
            let resolved = path.canonicalize()?;
            need(
                resolved.starts_with(&self.root),
                "RESUME_CONSOLE_LINK_ESCAPES",
            )?;
            graph.link(input::text(path)?, input::text(&raw)?)?;
            self.snapshots.push(Snapshot {
                path: path.into(),
                before,
                details: Details::Link { raw, resolved },
            });
        } else if metadata.is_dir() {
            self.readonly_directory(&metadata)?;
            graph.directory(input::text(path)?)?;
            pending.push((path.into(), before));
        } else {
            need(metadata.is_file(), "RESUME_PROGRAM_ENTRY")?;
            let measured = input::code(path, self.end)?;
            need(
                stamp(&fs::symlink_metadata(path)?) == before,
                "RESUME_PROGRAM_CHANGED",
            )?;
            graph.file(measured.pin, measured.mode)?;
            self.snapshots.push(Snapshot {
                path: path.into(),
                before,
                details: Details::File,
            });
        }
        Ok(())
    }
    fn readonly_directory(&self, m: &Metadata) -> Result<()> {
        need(
            m.is_dir() && m.uid() == self.uid && m.mode() & 0o222 == 0,
            "RESUME_READONLY_PROGRAM_DIRECTORY",
        )
    }
    pub(super) fn assert_current(&self) -> Result<()> {
        self.deadline()?;
        need(
            self.root.canonicalize()?.as_os_str() == self.root.as_os_str()
                && Some(stamp(
                    &self.file.as_ref().ok_or("RESUME_ROOT_CLOSED")?.metadata()?,
                )) == self.before,
            "RESUME_PROGRAM_ROOT_CHANGED",
        )?;
        for snapshot in &self.snapshots {
            self.deadline()?;
            need(
                stamp(&fs::symlink_metadata(&snapshot.path)?) == snapshot.before,
                "RESUME_PROGRAM_CHANGED",
            )?;
            match &snapshot.details {
                Details::File => {}
                Details::Directory(names) => need(
                    children(&snapshot.path, self.end)? == *names,
                    "RESUME_PROGRAM_INVENTORY_CHANGED",
                )?,
                Details::Link { raw, resolved } => need(
                    fs::read_link(&snapshot.path)? == *raw
                        && snapshot.path.canonicalize()? == *resolved,
                    "RESUME_PROGRAM_LINK_CHANGED",
                )?,
            }
        }
        self.deadline()
    }
    fn deadline(&self) -> Result<()> {
        need(Instant::now() < self.end, "RESUME_PROGRAM_DEADLINE")
    }
}
fn children(path: &Path, end: Instant) -> Result<Vec<OsString>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(path)? {
        need(Instant::now() < end, "RESUME_PROGRAM_DEADLINE")?;
        need(names.len() < MAX_PROGRAM_ENTRIES, "RESUME_PROGRAM_COUNT")?;
        names.push(entry?.file_name());
    }
    names.sort_by_cached_key(|name| {
        PythonText::try_new(posix_text::decode(name.as_bytes())).expect("filesystem codepoints")
    });
    Ok(names)
}
