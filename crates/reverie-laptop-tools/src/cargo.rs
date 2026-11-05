use crate::fs::{self, Directory, Stamp};
use std::ffi::OsStr;
use std::fmt;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_CONFIG: usize = 1_048_576;
const LINE: &str = "build-dir = \"/tmp/reverie/cargo-build/{workspace-path-hash}\"\n";
static TEMP: AtomicU64 = AtomicU64::new(0);
#[derive(Debug, PartialEq, Eq)]
pub enum MergeOutcome {
    Preserved,
    Merged,
}
#[derive(Debug, PartialEq, Eq)]
pub enum MergeError {
    UnsafeHome,
    LegacyConfig,
    UnsafeConfig,
    InvalidToml,
    NonstandardBuildTable,
    Changed,
    Busy,
    Io,
    Unconfirmed,
}
impl fmt::Display for MergeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::UnsafeHome => "refuse noncanonical or unsafe Cargo home",
            Self::LegacyConfig => "legacy Cargo config requires explicit migration; unchanged",
            Self::UnsafeConfig => "refuse unsafe or oversized Cargo config",
            Self::InvalidToml => "Cargo config is not valid TOML; unchanged",
            Self::NonstandardBuildTable => "nonstandard build table; unchanged",
            Self::Changed => "Cargo config changed; unchanged",
            Self::Busy => "Cargo defaults are already being configured; unchanged",
            Self::Io => "Cargo defaults could not be prepared; unchanged",
            Self::Unconfirmed => {
                "Cargo config publication unconfirmed; inspect config.toml before retrying"
            }
        })
    }
}
type Result<T> = std::result::Result<T, MergeError>;
struct Snapshot {
    raw: String,
    stamp: Option<Stamp>,
}
fn snapshot(directory: &Directory) -> Result<Snapshot> {
    let Some(mut file) = directory
        .read("config.toml")
        .map_err(|_| MergeError::UnsafeConfig)?
    else {
        return Ok(Snapshot {
            raw: String::new(),
            stamp: None,
        });
    };
    let before = Stamp::from_metadata(&file.metadata().map_err(|_| MergeError::UnsafeConfig)?);
    if !before.owned_file() || before.size > MAX_CONFIG as u64 {
        return Err(MergeError::UnsafeConfig);
    }
    let mut raw = Vec::new();
    let read = (&mut file)
        .take((MAX_CONFIG + 1) as u64)
        .read_to_end(&mut raw);
    let after = file.metadata().map(|meta| Stamp::from_metadata(&meta));
    let closed = fs::close(file);
    if read.is_err()
        || closed.is_err()
        || raw.len() > MAX_CONFIG
        || after.ok() != Some(before.clone())
    {
        return Err(MergeError::UnsafeConfig);
    }
    Ok(Snapshot {
        raw: String::from_utf8(raw).map_err(|_| MergeError::InvalidToml)?,
        stamp: Some(before),
    })
}
fn updated_config(raw: &str) -> Result<Option<String>> {
    let document: toml::Table = raw.parse().map_err(|_| MergeError::InvalidToml)?;
    if document
        .get("build")
        .is_some_and(|build| build.get("build-dir").is_some())
    {
        return Ok(None);
    }
    let updated = if document.contains_key("build") {
        let mut lines: Vec<_> = raw.split_inclusive('\n').map(str::to_owned).collect();
        let positions: Vec<_> = lines
            .iter()
            .enumerate()
            .filter(|(_, line)| line.trim().split('#').next().unwrap_or("").trim() == "[build]")
            .map(|(index, _)| index)
            .collect();
        if positions.len() != 1 {
            return Err(MergeError::NonstandardBuildTable);
        }
        let position = positions[0];
        if !lines[position].ends_with('\n') {
            lines[position].push('\n');
        }
        lines.insert(position + 1, LINE.into());
        lines.concat()
    } else {
        format!(
            "{raw}{}[build]\n{LINE}",
            if raw.is_empty() { "" } else { "\n" }
        )
    };
    let check: toml::Table = updated.parse().map_err(|_| MergeError::InvalidToml)?;
    if check
        .get("build")
        .and_then(|table| table.get("build-dir"))
        .and_then(toml::Value::as_str)
        != Some("/tmp/reverie/cargo-build/{workspace-path-hash}")
    {
        return Err(MergeError::InvalidToml);
    }
    Ok(Some(updated))
}
struct Temporary<'a> {
    directory: &'a Directory,
    name: String,
    stamp: Stamp,
    armed: bool,
}
impl Drop for Temporary<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.directory.remove_owned(&self.name, &self.stamp);
        }
    }
}
fn prepare<'a>(directory: &'a Directory, raw: &str) -> Result<Temporary<'a>> {
    let name = format!(
        ".config-{}-{}",
        std::process::id(),
        TEMP.fetch_add(1, Ordering::Relaxed)
    );
    let mut file = directory.create(&name).map_err(|_| MergeError::Io)?;
    let stamp = Stamp::from_metadata(&file.metadata().map_err(|_| MergeError::Io)?);
    let mut temporary = Temporary {
        directory,
        name,
        stamp,
        armed: true,
    };
    let written = file
        .write_all(raw.as_bytes())
        .and_then(|()| file.sync_all());
    let verified = if written.is_ok() {
        verify_prepared(&mut file, raw)
    } else {
        Err(MergeError::Io)
    };
    let closed = fs::close(file);
    if closed.is_err() {
        return Err(MergeError::Io);
    }
    temporary.stamp = verified?;
    Ok(temporary)
}
fn verify_prepared(file: &mut std::fs::File, expected: &str) -> Result<Stamp> {
    let before = Stamp::from_metadata(&file.metadata().map_err(|_| MergeError::Io)?);
    if !before.owned_file() || before.mode & 0o077 != 0 {
        return Err(MergeError::Changed);
    }
    file.seek(SeekFrom::Start(0)).map_err(|_| MergeError::Io)?;
    let mut bytes = Vec::new();
    (&mut *file)
        .take((MAX_CONFIG + 1025) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| MergeError::Io)?;
    let after = Stamp::from_metadata(&file.metadata().map_err(|_| MergeError::Io)?);
    if bytes != expected.as_bytes() || after != before {
        return Err(MergeError::Changed);
    }
    Ok(after)
}
fn same_directory(home: &Path, directory: &Directory) -> Result<bool> {
    let parent = Directory::open(home).map_err(|_| MergeError::Changed)?;
    let parent_owned = parent.metadata().is_ok_and(|meta| meta.owned_directory());
    let current = parent
        .child(OsStr::new(".cargo"), false)
        .map_err(|_| MergeError::Changed)?;
    let equal = current
        .metadata()
        .ok()
        .zip(directory.metadata().ok())
        .is_some_and(|(a, b)| {
            parent_owned && a.owned_directory() && b.owned_directory() && a.same_inode(&b)
        });
    current
        .close()
        .and(parent.close())
        .map_err(|_| MergeError::Changed)?;
    Ok(equal)
}
fn merge_locked<F: FnOnce()>(
    home: &Path,
    directory: &Directory,
    before_publish: F,
) -> Result<MergeOutcome> {
    if directory
        .stamp("config")
        .map_err(|_| MergeError::UnsafeConfig)?
        .is_some()
    {
        return Err(MergeError::LegacyConfig);
    }
    let before = snapshot(directory)?;
    let Some(updated) = updated_config(&before.raw)? else {
        return Ok(MergeOutcome::Preserved);
    };
    let mut temporary = prepare(directory, &updated)?;
    before_publish();
    if directory
        .stamp("config")
        .map_err(|_| MergeError::Changed)?
        .is_some()
        || directory
            .stamp("config.toml")
            .map_err(|_| MergeError::Changed)?
            != before.stamp
        || !same_directory(home, directory)?
        || directory
            .stamp(&temporary.name)
            .map_err(|_| MergeError::Changed)?
            != Some(temporary.stamp.clone())
    {
        return Err(MergeError::Changed);
    }
    directory
        .publish(&temporary.name, "config.toml", before.stamp.is_none())
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                MergeError::Changed
            } else {
                MergeError::Unconfirmed
            }
        })?;
    temporary.armed = false;
    directory.sync().map_err(|_| MergeError::Unconfirmed)?;
    Ok(MergeOutcome::Merged)
}
/// Insert the optional Cargo intermediate directory without rewriting existing settings.
/// Cooperating calls lock the owned directory; unrelated editors must remain quiescent.
pub fn merge_cargo_defaults(home: &Path) -> Result<MergeOutcome> {
    merge_with_hook(home, || {})
}
fn merge_with_hook<F: FnOnce()>(home: &Path, before_publish: F) -> Result<MergeOutcome> {
    let parent = Directory::open(home).map_err(|_| MergeError::UnsafeHome)?;
    if !parent
        .metadata()
        .map_err(|_| MergeError::UnsafeHome)?
        .owned_directory()
    {
        return Err(MergeError::UnsafeHome);
    }
    let directory = parent
        .child(OsStr::new(".cargo"), true)
        .map_err(|_| MergeError::UnsafeHome)?;
    if !directory
        .metadata()
        .map_err(|_| MergeError::UnsafeHome)?
        .owned_directory()
    {
        return Err(MergeError::UnsafeHome);
    }
    directory.lock().map_err(|_| MergeError::Busy)?;
    let result = merge_locked(home, &directory, before_publish);
    let closed = directory.close().and(parent.close());
    if closed.is_err() && result == Ok(MergeOutcome::Merged) {
        return Err(MergeError::Unconfirmed);
    }
    if closed.is_err() && result.is_ok() {
        return Err(MergeError::Io);
    }
    result
}

#[cfg(test)]
pub(super) fn test_merge<F: FnOnce()>(home: &Path, hook: F) -> Result<MergeOutcome> {
    merge_with_hook(home, hook)
}
