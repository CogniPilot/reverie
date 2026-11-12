//! Sole owner of fresh build-output directory/file descriptors. Its builder UID
//! checks deliberately do not use the immutable store-input ownership mapping.
use crate::{
    build_input::{Result, combine, need},
    output,
};
use nix::unistd::Uid;
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const DIRECTORIES: [&str; 7] = [
    "",
    "opt",
    "opt/reverie",
    "opt/reverie/human",
    "opt/reverie/human/bin",
    "share",
    "share/reverie-human-terminal",
];
#[derive(Clone, Copy, Eq, PartialEq)]
struct Stamp {
    device: u64,
    inode: u64,
    uid: u32,
    gid: u32,
    mode: u32,
    links: u64,
    bytes: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}
fn stamp(m: &Metadata) -> Stamp {
    Stamp {
        device: m.dev(),
        inode: m.ino(),
        uid: m.uid(),
        gid: m.gid(),
        mode: m.mode(),
        links: m.nlink(),
        bytes: m.len(),
        modified: (m.mtime(), m.mtime_nsec()),
        changed: (m.ctime(), m.ctime_nsec()),
    }
}
struct Directory {
    path: PathBuf,
    file: Option<File>,
    stamp: Option<Stamp>,
}
pub(super) struct Root {
    path: PathBuf,
    uid: u32,
    directories: Vec<Directory>,
    leaves: Vec<(PathBuf, Stamp)>,
}
pub(super) fn with_root<T>(path: &Path, body: impl FnOnce(&mut Root) -> Result<T>) -> Result<T> {
    need(
        path.is_absolute()
            && path.parent() == Some(Path::new("/nix/store"))
            && path.canonicalize()?.as_os_str() == path.as_os_str(),
        "HUMAN_TOOLKIT_FRESH_OUTPUT_ROOT",
    )?;
    let mut root = Root {
        path: path.into(),
        uid: Uid::effective().as_raw(),
        directories: Vec::new(),
        leaves: Vec::new(),
    };
    let result = root.prepare().and_then(|()| body(&mut root));
    combine(result, root.close())
}
impl Root {
    fn prepare(&mut self) -> Result<()> {
        for relative in DIRECTORIES {
            let path = self.path.join(relative);
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&path)?;
            // Transfer ownership before any metadata/error path.
            self.directories.push(Directory {
                path,
                file: Some(file),
                stamp: None,
            });
            let directory = self
                .directories
                .last_mut()
                .expect("just retained directory");
            let metadata = directory
                .file
                .as_ref()
                .expect("retained directory")
                .metadata()?;
            need(
                metadata.is_dir() && metadata.uid() == self.uid && metadata.mode() & 0o022 == 0,
                "HUMAN_TOOLKIT_BUILDER_DIRECTORY",
            )?;
            directory.stamp = Some(stamp(&metadata));
        }
        self.inventory()
    }
    fn inventory(&self) -> Result<()> {
        let mut names = Vec::new();
        for entry in fs::read_dir(self.path.join("opt/reverie/human/bin"))? {
            need(names.len() < 2, "HUMAN_TOOLKIT_EXACT_TWO_FILES")?;
            names.push(entry?.file_name());
        }
        names.sort();
        need(
            names
                == [
                    std::ffi::OsString::from("bash"),
                    std::ffi::OsString::from("reverie-human-shell"),
                ],
            "HUMAN_TOOLKIT_EXACT_TWO_FILES",
        )
    }
    pub(super) fn read(&mut self, relative: &str) -> Result<Vec<u8>> {
        let path = self.path.join(relative);
        need(path.canonicalize()? == path, "HUMAN_TOOLKIT_DIRECT_FILE")?;
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(&path)?;
        let result = (|| {
            let before = file.metadata()?;
            need(
                before.is_file()
                    && before.uid() == self.uid
                    && before.mode() & 0o7777 == 0o555
                    && (64..=16 << 20).contains(&before.len()),
                "HUMAN_TOOLKIT_READONLY_FILE_BOUND",
            )?;
            let mut data = Vec::new();
            (&mut file).take((16 << 20) + 1).read_to_end(&mut data)?;
            need(
                data.len() as u64 == before.len()
                    && stamp(&file.metadata()?) == stamp(&before)
                    && stamp(&fs::symlink_metadata(&path)?) == stamp(&before),
                "HUMAN_TOOLKIT_FILE_CHANGED",
            )?;
            self.leaves.push((path, stamp(&before)));
            Ok(data)
        })();
        combine(result, output::close(file).map_err(Into::into))
    }
    pub(super) fn assert_current(&self) -> Result<()> {
        need(
            self.path.canonicalize()? == self.path,
            "HUMAN_TOOLKIT_OUTPUT_ROOT_CHANGED",
        )?;
        for directory in &self.directories {
            let expected = directory
                .stamp
                .ok_or("HUMAN_TOOLKIT_DIRECTORY_UNVALIDATED")?;
            need(
                stamp(
                    &directory
                        .file
                        .as_ref()
                        .ok_or("HUMAN_TOOLKIT_DIRECTORY_CLOSED")?
                        .metadata()?,
                ) == expected
                    && stamp(&fs::symlink_metadata(&directory.path)?) == expected,
                "HUMAN_TOOLKIT_DIRECTORY_CHANGED",
            )?;
        }
        for (path, expected) in &self.leaves {
            need(
                stamp(&fs::symlink_metadata(path)?) == *expected,
                "HUMAN_TOOLKIT_FILE_CHANGED",
            )?;
        }
        self.inventory()
    }
    fn close(&mut self) -> Result<()> {
        let mut result = Ok(());
        for directory in self.directories.iter_mut().rev() {
            if let Some(file) = directory.file.take() {
                result = combine(result, output::close(file).map_err(Into::into));
            }
        }
        result
    }
}
