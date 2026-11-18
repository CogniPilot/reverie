use super::{Result, Unavailable};
use nix::unistd::{AccessFlags, access};
use std::{
    fs::{self, ReadDir},
    io,
    path::{Path, PathBuf},
};

const PROJECT_LIMIT: usize = 4096;

pub(super) fn select(config: &Path, ids: &[String]) -> Result<Option<usize>> {
    let projects = config.join("projects");
    let Some(entries) = absent(fs::read_dir(&projects))? else {
        prove_missing_projects(&projects)?;
        return Ok(None);
    };
    let directories = project_directories(entries)?;
    for (index, id) in ids.iter().enumerate() {
        if observed(&directories, &format!("{id}.jsonl"))? {
            return Ok(Some(index));
        }
    }
    Ok(None)
}

fn absent<T>(observed: io::Result<T>) -> Result<Option<T>> {
    match observed {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(Unavailable),
    }
}

fn prove_missing_projects(projects: &Path) -> Result<()> {
    if absent(projects.symlink_metadata())?.is_some() {
        return Err(Unavailable);
    }
    for parent in projects.ancestors().skip(1) {
        if absent(parent.symlink_metadata())?.is_some() {
            return match parent.metadata() {
                Ok(metadata) if metadata.is_dir() => Ok(()),
                _ => Err(Unavailable),
            };
        }
    }
    Err(Unavailable)
}

fn project_directories(entries: ReadDir) -> Result<Vec<PathBuf>> {
    let mut directories = Vec::new();
    // Same total entry budget for files, directories and symlink targets.
    for (index, entry) in entries.enumerate() {
        if index >= PROJECT_LIMIT {
            return Err(Unavailable);
        }
        let path = entry.map_err(|_| Unavailable)?.path();
        if path.metadata().map_err(|_| Unavailable)?.is_dir() {
            directories.push(path);
        }
    }
    Ok(directories)
}

fn observed(directories: &[PathBuf], file: &str) -> Result<bool> {
    for directory in directories {
        let path = directory.join(file);
        match absent(path.metadata())? {
            Some(metadata) if metadata.is_file() && access(&path, AccessFlags::R_OK).is_ok() => {
                return Ok(true);
            }
            Some(_) => return Err(Unavailable),
            None if directory.is_dir() && absent(path.symlink_metadata())?.is_none() => {}
            None => return Err(Unavailable),
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_faults_never_count_as_absence() {
        let io_fault = io::Error::from_raw_os_error(nix::libc::EIO);
        assert!(absent::<()>(Err(io_fault)).is_err());
        assert!(absent::<()>(Err(io::ErrorKind::PermissionDenied.into())).is_err());
        assert!(
            absent::<()>(Err(io::ErrorKind::NotFound.into()))
                .unwrap()
                .is_none()
        );
    }
}
