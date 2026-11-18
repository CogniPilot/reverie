//! Old Cargo target directories in the registered company's persistent workspace.
use super::*;
use rustix::fs::{self as native, AtFlags, Dir, FileType};
use std::{
    ffi::{CStr, CString, OsStr},
    fs::File,
    io::Read,
    os::{
        fd::AsRawFd,
        unix::{ffi::OsStrExt, fs::OpenOptionsExt},
    },
    time::{SystemTime, UNIX_EPOCH},
};

const DESTINATION: &str = "/reverie_workspace";
const CHANGED: &str = "WORKSPACE_CACHE_LAYOUT_CHANGED";
const CARGO_TAG: &[u8] = b"Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by cargo.\n";
const MAX_DISCOVERY_DEPTH: usize = 10;

impl DeploymentService {
    /// Preview or explicitly remove old, Cargo-tagged rebuildable workspace outputs.
    pub fn prune_workspace(
        &self,
        apply: bool,
        min_age_days: u16,
        additional: &[PathBuf],
    ) -> Result<Value> {
        let selection = self.storage_selection(DESTINATION)?;
        let scope = Scope::open(&selection.root)?;
        let blockers = self.storage_blockers(&selection, &scope.path)?;
        if apply && !blockers.is_empty() {
            return Ok(report(
                &scope.path,
                min_age_days,
                apply,
                &blockers,
                &[],
                false,
            ));
        }
        let leases = if apply {
            Some(self.storage_leases(&scope.path, additional)?)
        } else {
            None
        };
        let cutoff = cutoff(min_age_days)?;
        let mut rows = Vec::new();
        for path in scope.candidates()? {
            let (parent, name) = scope.locate(&path)?;
            let cache = tree::Cache::observe(&parent, &name)?;
            let mut row = cache.row(&scope.path.join(&path), cutoff);
            if apply && cache.disposition(cutoff) == "eligible" {
                let current = self.storage_selection(DESTINATION)?;
                require(current == selection, "WORKSPACE_BIND_CHANGED")?;
                require(
                    self.storage_blockers(&current, &scope.path)?.is_empty(),
                    "WORKSPACE_IN_USE",
                )?;
                scope.check(&path, &parent)?;
                record_apply(&mut row, cache.clear(&parent, &name, cutoff));
            }
            rows.push(row);
        }
        if let Some(leases) = leases {
            leases
                .finish()
                .map_err(|_| DeploymentError::new("SCRATCH_FINALIZATION_UNCONFIRMED"))?;
        }
        let success = rows.iter().all(|row| row["applyState"] != "unconfirmed");
        Ok(report(
            &scope.path,
            min_age_days,
            apply,
            &blockers,
            &rows,
            success,
        ))
    }
}

fn cutoff(days: u16) -> Result<i64> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
        .ok_or_else(|| DeploymentError::new("WORKSPACE_CLOCK_UNAVAILABLE"))?;
    Ok(now.saturating_sub(i64::from(days) * 86_400))
}

struct Scope {
    path: PathBuf,
    directory: File,
}

impl Scope {
    fn open(workspace: &Path) -> Result<Self> {
        let root = fs::OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW)
            .open(workspace)?;
        tree::private(&root)?;
        let directory =
            tree::open_child(&root, "cases", true).map_err(|_| DeploymentError::new(CHANGED))?;
        let path = workspace.join("cases");
        require(path.canonicalize()? == path, CHANGED)?;
        Ok(Self { path, directory })
    }

    fn candidates(&self) -> Result<Vec<PathBuf>> {
        let mut paths = Vec::new();
        for expert in directories(&self.directory)? {
            if !expert.to_bytes().starts_with(b"expert-") {
                continue;
            }
            self.discover_expert(&expert, &mut paths)?;
        }
        paths.sort_unstable();
        Ok(paths)
    }

    fn discover_expert(&self, expert: &CStr, paths: &mut Vec<PathBuf>) -> Result<()> {
        let Some(directory) = readable_directory(&self.directory, expert) else {
            return Ok(());
        };
        if kept(&directory) {
            return Ok(());
        }
        let Some(work) = readable_directory(&directory, c"work") else {
            return Ok(());
        };
        let path = Path::new(OsStr::from_bytes(expert.to_bytes())).join("work");
        discover(&work, &path, 0, paths)
    }

    fn locate(&self, path: &Path) -> Result<(File, CString)> {
        let parent = path.parent().ok_or_else(|| DeploymentError::new(CHANGED))?;
        let name = path
            .file_name()
            .and_then(|name| CString::new(name.as_bytes()).ok())
            .ok_or_else(|| DeploymentError::new(CHANGED))?;
        let parent = tree::open_child(&self.directory, parent, true)
            .map_err(|_| DeploymentError::new(CHANGED))?;
        Ok((parent, name))
    }

    fn check(&self, path: &Path, parent: &File) -> Result<()> {
        let cases = File::open(&self.path)?;
        require(self.path.canonicalize()? == self.path, CHANGED)?;
        tree::same_file(&cases, &self.directory)?;
        for ancestor in path
            .ancestors()
            .skip(1)
            .filter(|path| !path.as_os_str().is_empty())
        {
            let directory = tree::open_child(&self.directory, ancestor, true)
                .map_err(|_| DeploymentError::new(CHANGED))?;
            require(!kept(&directory), CHANGED)?;
        }
        let (current, name) = self.locate(path)?;
        tree::same_file(&current, parent)?;
        let directory =
            readable_directory(&current, &name).ok_or_else(|| DeploymentError::new(CHANGED))?;
        require(cargo_target(&directory), CHANGED)
    }
}

fn discover(
    directory: &File,
    relative: &Path,
    depth: usize,
    paths: &mut Vec<PathBuf>,
) -> Result<()> {
    if kept(directory) {
        return Ok(());
    }
    if depth > 0 && cargo_target(directory) {
        paths.push(relative.to_owned());
        return Ok(());
    }
    if depth >= MAX_DISCOVERY_DEPTH {
        return Ok(());
    }
    for name in directories(directory)? {
        if excluded(&name) {
            continue;
        }
        let Some(child) = readable_directory(directory, &name) else {
            continue;
        };
        let next = relative.join(OsStr::from_bytes(name.to_bytes()));
        discover(&child, &next, depth + 1, paths)?;
    }
    Ok(())
}

fn excluded(name: &CStr) -> bool {
    matches!(
        name.to_bytes(),
        b".git" | b".hg" | b".svn" | b"node_modules" | b".cargo" | b"registry" | b"vendor"
    )
}

fn directories(directory: &File) -> Result<Vec<CString>> {
    let entries = Dir::read_from(directory).map_err(|_| DeploymentError::new(CHANGED))?;
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| DeploymentError::new(CHANGED))?;
        let name = entry.file_name();
        if matches!(entry.file_type(), FileType::Directory | FileType::Unknown)
            && !matches!(name.to_bytes(), b"." | b"..")
        {
            names.push(name.to_owned());
        }
    }
    Ok(names)
}

fn readable_directory(parent: &File, name: &CStr) -> Option<File> {
    tree::open_child(parent, name, true).ok()
}

fn kept(directory: &File) -> bool {
    [c".keep", c".reverie-task.json"].iter().any(|name| {
        !matches!(
            native::statat(directory, *name, AtFlags::SYMLINK_NOFOLLOW),
            Err(rustix::io::Errno::NOENT)
        )
    })
}

fn cargo_target(directory: &File) -> bool {
    let Ok(stamp) = native::statat(directory, c".rustc_info.json", AtFlags::SYMLINK_NOFOLLOW)
    else {
        return false;
    };
    if FileType::from_raw_mode(stamp.st_mode) != FileType::RegularFile {
        return false;
    }
    let Ok(tag) = tree::open_child(directory, c"CACHEDIR.TAG", false) else {
        return false;
    };
    if !tag.metadata().is_ok_and(|info| info.is_file()) {
        return false;
    }
    let Ok(reader) = File::open(format!("/proc/self/fd/{}", tag.as_raw_fd())) else {
        return false;
    };
    let mut prefix = [0u8; CARGO_TAG.len()];
    (&reader).read_exact(&mut prefix).is_ok() && prefix == CARGO_TAG
}

fn report(
    root: &Path,
    age: u16,
    apply: bool,
    blockers: &[String],
    rows: &[Value],
    success: bool,
) -> Value {
    let eligible = rows
        .iter()
        .filter_map(|row| row["eligibleBytes"].as_u64())
        .fold(0, u64::saturating_add);
    json!({
        "success": success,
        "mode": if apply { "apply" } else { "preview" },
        "code": (apply && !blockers.is_empty()).then_some("WORKSPACE_IN_USE"),
        "workspaceCases": root,
        "minimumAgeDays": age,
        "blockingContainers": blockers,
        "eligibleBytes": eligible,
        "targets": rows,
    })
}

#[cfg(test)]
mod tests;
