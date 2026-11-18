use super::*;
use rustix::fs::{self as native, AtFlags, Dir, Mode, OFlags, ResolveFlags, Stat};
use std::{
    ffi::{CStr, CString, OsStr},
    fs::File,
    os::unix::{ffi::OsStrExt, fs::OpenOptionsExt},
};

const TREE_CHANGED: &str = "SCRATCH_TREE_CHANGED_OR_UNREADABLE";
const PROTECTED: [&[u8]; 5] = [b".keep", b".git", b".hg", b".svn", b".reverie-task.json"];
const MAX_DEPTH: usize = 128;

pub(super) struct Layout {
    pub(super) path: PathBuf,
    directory: File,
}

impl Layout {
    pub(super) fn open(scratch: PathBuf) -> Result<Self> {
        let path = scratch.join("laptops");
        require(path.canonicalize()? == path, TREE_CHANGED)?;
        let scratch = fs::OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW)
            .open(scratch)?;
        let directory = open_child(&scratch, "laptops", true)
            .map_err(|_| DeploymentError::new(TREE_CHANGED))?;
        private(&directory)?;
        Ok(Self { path, directory })
    }

    pub(super) fn targets(&self) -> Result<Vec<Target>> {
        let mut result = Vec::new();
        self.check_root()?;
        for category in GROUPS {
            self.add_group(category, &mut result)?;
        }
        Ok(result)
    }

    fn add_group(&self, category: &str, result: &mut Vec<Target>) -> Result<()> {
        let directory = match open_child(&self.directory, category, true) {
            Ok(file) => file,
            Err(rustix::io::Errno::NOENT) => return Ok(()),
            Err(_) => return Err(DeploymentError::new(TREE_CHANGED)),
        };
        for name in names(&directory)? {
            let id = OsStr::from_bytes(name.to_bytes());
            if !is_uuid(id) {
                continue;
            }
            let relative = Path::new(category).join(id).join("tmp");
            let temporary = match open_child(&self.directory, &relative, true) {
                Ok(file) => file,
                Err(rustix::io::Errno::NOENT) => continue,
                Err(_) => return Err(DeploymentError::new(TREE_CHANGED)),
            };
            private(&temporary)?;
            result.push(Target {
                path: self.path.join(&relative),
                relative,
                directory: temporary,
            });
        }
        Ok(())
    }

    fn check_root(&self) -> Result<()> {
        let observed = fs::symlink_metadata(&self.path)?;
        let held = self.directory.metadata()?;
        require(
            self.path.canonicalize()? == self.path
                && (observed.dev(), observed.ino()) == (held.dev(), held.ino()),
            TREE_CHANGED,
        )
    }

    pub(super) fn check(&self, target: &Target) -> Result<()> {
        self.check_root()?;
        let named = open_child(&self.directory, &target.relative, true)
            .map_err(|_| DeploymentError::new(TREE_CHANGED))?;
        same_file(&named, &target.directory)?;
        private(&named)
    }
}

pub(super) struct Target {
    path: PathBuf,
    relative: PathBuf,
    directory: File,
}

pub(super) struct Inspection {
    pub(super) row: Value,
    eligible: Vec<(CString, Stat)>,
    force_read_only: bool,
}

impl Inspection {
    pub(super) fn has_eligible_entries(&self) -> bool {
        !self.eligible.is_empty()
    }
}

impl Target {
    pub(super) fn inspect(&self, force_read_only: bool) -> Result<Inspection> {
        let names = names(&self.directory)?;
        let protected_root = names.iter().any(|name| protected_name(name));
        let mut allocated = 0u64;
        let mut eligible_bytes = 0u64;
        let mut eligible = Vec::new();
        let mut protected = Vec::new();
        let mut unknown = Vec::new();
        for name in names {
            let Ok((info, usage)) = scan_entry(&self.directory, &name, 0, force_read_only) else {
                unknown.push(name.to_string_lossy().into_owned());
                continue;
            };
            allocated = allocated.saturating_add(usage.allocated);
            if usage.unreadable {
                unknown.push(name.to_string_lossy().into_owned());
            } else if protected_root || usage.protected {
                protected.push(name.to_string_lossy().into_owned());
            } else {
                eligible_bytes = eligible_bytes.saturating_add(usage.reclaimable);
                eligible.push((name, info));
            }
        }
        let row = json!({
            "path": self.path,
            "allocatedBytes": allocated,
            "allocatedBytesComplete": unknown.is_empty(),
            "eligibleBytes": eligible_bytes,
            "eligibleEntries": eligible.len(),
            "protectedEntries": protected,
            "unreadableEntries": unknown,
        });
        Ok(Inspection {
            row,
            eligible,
            force_read_only,
        })
    }

    pub(super) fn clear(&self, inspection: &Inspection) -> Result<()> {
        for (name, expected) in &inspection.eligible {
            clear_entry(
                &self.directory,
                name,
                Some(expected),
                0,
                inspection.force_read_only,
            )?;
        }
        self.directory.sync_all()?;
        Ok(())
    }
}

#[derive(Default)]
struct Usage {
    allocated: u64,
    reclaimable: u64,
    protected: bool,
    unreadable: bool,
    newest_change: i64,
}

impl Usage {
    fn include(&mut self, child: Self) {
        self.allocated = self.allocated.saturating_add(child.allocated);
        self.reclaimable = self.reclaimable.saturating_add(child.reclaimable);
        self.protected |= child.protected;
        self.unreadable |= child.unreadable;
        self.newest_change = self.newest_change.max(child.newest_change);
    }
}

fn scan_entry(
    parent: &File,
    name: &CStr,
    depth: usize,
    force_read_only: bool,
) -> Result<(Stat, Usage)> {
    require(depth < MAX_DEPTH, TREE_CHANGED)?;
    let (entry, info) = open_entry(parent, name)?;
    let kind = native::FileType::from_raw_mode(info.st_mode);
    let bytes = u64::try_from(info.st_blocks)
        .unwrap_or_default()
        .saturating_mul(512);
    let mut usage = Usage {
        allocated: bytes,
        reclaimable: if kind == native::FileType::Directory || info.st_nlink == 1 {
            bytes
        } else {
            0
        },
        protected: !can_remove(name, &info, kind, force_read_only),
        unreadable: false,
        newest_change: info.st_mtime.max(info.st_ctime),
    };
    if kind == native::FileType::Directory {
        scan_children(parent, name, &entry, depth, force_read_only, &mut usage)?;
    }
    Ok((info, usage))
}

fn scan_children(
    parent: &File,
    name: &CStr,
    entry: &File,
    depth: usize,
    force_read_only: bool,
    usage: &mut Usage,
) -> Result<()> {
    let directory = read_entry(parent, name, entry)?;
    for name in names(&directory)? {
        match scan_entry(&directory, &name, depth + 1, force_read_only) {
            Ok((_, child)) => usage.include(child),
            Err(_) => usage.unreadable = true,
        }
    }
    Ok(())
}

fn clear_entry(
    parent: &File,
    name: &CStr,
    expected: Option<&Stat>,
    depth: usize,
    force_read_only: bool,
) -> Result<()> {
    require(depth < MAX_DEPTH, TREE_CHANGED)?;
    let (entry, info) = open_entry(parent, name)?;
    let kind = native::FileType::from_raw_mode(info.st_mode);
    require(can_remove(name, &info, kind, force_read_only), TREE_CHANGED)?;
    if let Some(expected) = expected {
        require(
            identity(expected) == identity(&info)
                && (expected.st_nlink > 1 && kind != native::FileType::Directory
                    || (expected.st_ctime, expected.st_ctime_nsec)
                        == (info.st_ctime, info.st_ctime_nsec)),
            TREE_CHANGED,
        )?;
    }
    let flags = if kind == native::FileType::Directory {
        let directory = read_entry(parent, name, &entry)?;
        clear_children(&directory, info.st_mode, depth, force_read_only)?;
        AtFlags::REMOVEDIR
    } else {
        AtFlags::empty()
    };
    let (named, _) = open_entry(parent, name)?;
    same_file(&entry, &named)?;
    native::unlinkat(parent, name, flags).map_err(|_| DeploymentError::new(TREE_CHANGED))
}

fn clear_children(directory: &File, mode: u32, depth: usize, force_read_only: bool) -> Result<()> {
    let mode = Mode::from_bits_truncate(mode);
    let grant_write = !mode.contains(Mode::WUSR);
    if grant_write {
        require(force_read_only, TREE_CHANGED)?;
        set_mode(directory, mode | Mode::WUSR)?;
    }
    let cleared = (|| {
        for name in names(directory)? {
            clear_entry(directory, &name, None, depth + 1, force_read_only)?;
        }
        Ok(())
    })();
    if grant_write {
        DeploymentError::finalized(cleared, set_mode(directory, mode))
    } else {
        cleared
    }
}

fn set_mode(directory: &File, mode: Mode) -> Result<()> {
    native::fchmod(directory, mode)
        .map_err(|_| DeploymentError::new("SCRATCH_DIRECTORY_MODE_UNCONFIRMED"))
}

fn open_entry(parent: &File, name: &CStr) -> Result<(File, Stat)> {
    let entry = open_child(parent, name, false).map_err(|_| DeploymentError::new(TREE_CHANGED))?;
    let stat = native::fstat(&entry).map_err(|_| DeploymentError::new(TREE_CHANGED))?;
    Ok((entry, stat))
}

fn read_entry(parent: &File, name: &CStr, entry: &File) -> Result<File> {
    let directory =
        open_child(parent, name, true).map_err(|_| DeploymentError::new(TREE_CHANGED))?;
    same_file(entry, &directory)?;
    Ok(directory)
}

pub(super) fn open_child(
    parent: &File,
    name: impl rustix::path::Arg,
    directory: bool,
) -> rustix::io::Result<File> {
    let mode = if directory {
        OFlags::RDONLY | OFlags::DIRECTORY
    } else {
        OFlags::PATH
    };
    native::openat2(
        parent,
        name,
        mode | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
        ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_XDEV,
    )
    .map(File::from)
}

fn names(file: &File) -> Result<Vec<CString>> {
    let directory = Dir::read_from(file).map_err(|_| DeploymentError::new(TREE_CHANGED))?;
    let mut names = Vec::new();
    for entry in directory {
        let entry = entry.map_err(|_| DeploymentError::new(TREE_CHANGED))?;
        let name = entry.file_name();
        if !matches!(name.to_bytes(), b"." | b"..") {
            names.push(name.to_owned());
        }
    }
    names.sort_unstable();
    Ok(names)
}

pub(super) fn private(directory: &File) -> Result<()> {
    let info = directory.metadata()?;
    require(
        info.uid() == nix::unistd::geteuid().as_raw() && info.mode() & 0o7777 == 0o700,
        "SCRATCH_PRIVATE_DIRECTORY_REQUIRED",
    )
}

fn identity(info: &Stat) -> (u64, u64, u32) {
    (info.st_dev, info.st_ino, info.st_mode)
}

pub(super) fn same_file(left: &File, right: &File) -> Result<()> {
    let get = |file| native::fstat(file).map_err(|_| DeploymentError::new(TREE_CHANGED));
    require(
        identity(&get(left)?) == identity(&get(right)?),
        TREE_CHANGED,
    )
}

fn protected_name(name: &CStr) -> bool {
    PROTECTED.contains(&name.to_bytes())
}

pub(super) struct Cache {
    stamp: Stat,
    usage: Usage,
}

impl Cache {
    pub(super) fn observe(parent: &File, name: &CStr) -> Result<Self> {
        let (stamp, usage) = scan_entry(parent, name, 0, false)?;
        require(
            native::FileType::from_raw_mode(stamp.st_mode) == native::FileType::Directory,
            TREE_CHANGED,
        )?;
        Ok(Self { stamp, usage })
    }

    pub(super) fn row(&self, path: &Path, cutoff: i64) -> Value {
        let disposition = self.disposition(cutoff);
        json!({
            "path": path,
            "status": disposition,
            "allocatedBytes": self.usage.allocated,
            "eligibleBytes": if disposition == "eligible" { self.usage.reclaimable } else { 0 },
            "newestChangeUnixSeconds": self.usage.newest_change,
        })
    }

    pub(super) fn disposition(&self, cutoff: i64) -> &'static str {
        if self.usage.unreadable {
            "unreadable"
        } else if self.usage.protected {
            "protected"
        } else if self.usage.newest_change >= cutoff {
            "recent"
        } else {
            "eligible"
        }
    }

    pub(super) fn clear(&self, parent: &File, name: &CStr, cutoff: i64) -> Result<()> {
        require(self.disposition(cutoff) == "eligible", TREE_CHANGED)?;
        clear_entry(parent, name, Some(&self.stamp), 0, false)?;
        parent.sync_all()?;
        Ok(())
    }
}

fn can_remove(name: &CStr, info: &Stat, kind: native::FileType, force_read_only: bool) -> bool {
    !protected_name(name)
        && info.st_uid == nix::unistd::geteuid().as_raw()
        && (kind != native::FileType::Directory || (info.st_mode & 0o200 != 0) || force_read_only)
        && matches!(
            kind,
            native::FileType::RegularFile | native::FileType::Directory | native::FileType::Symlink
        )
}

pub(super) fn is_uuid(value: &OsStr) -> bool {
    let value = value.as_bytes();
    value.len() == 36
        && value.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)
            }
        })
}

#[cfg(test)]
mod tests;
