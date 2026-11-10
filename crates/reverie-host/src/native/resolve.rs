//! Strict absolute pathlib.Path(str).resolve semantics. Preserve the original
//! Python codepoints of untouched components; fsdecode only readlink results.
//! No inode remains pinned and no mount/effect authority is established.
#![forbid(unsafe_code)]
use super::{python_path, python_text};
use reverie_core::posix_path::PosixPath;
use std::{collections::BTreeMap, fs, io};
#[cfg(test)]
mod tests;

enum Pending {
    Component(Vec<u32>),
    Cache(Vec<u32>),
}
struct Resolver {
    path: Vec<u32>,
    pending: Vec<Pending>,
    remaining: usize,
    seen: BTreeMap<Vec<u32>, Option<Vec<u32>>>,
    mode: Mode,
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum Mode {
    Strict,
    Optional,
    Future,
}
pub(crate) fn resolve_strict_text(points: &[u32]) -> io::Result<PosixPath> {
    resolve_text(points, Mode::Strict)
}
pub(crate) fn resolve_optional_text(points: &[u32]) -> io::Result<PosixPath> {
    resolve_text(points, Mode::Optional)
}
/// Resolve a future bind source. Only absence is tolerated; access failures,
/// non-directory ancestors and symlink loops remain failures. This is path
/// DATA, never evidence that a running mount or its inode has been observed.
pub(crate) fn resolve_future_text(points: &[u32]) -> io::Result<PosixPath> {
    resolve_text(points, Mode::Future)
}
fn resolve_text(points: &[u32], mode: Mode) -> io::Result<PosixPath> {
    let input = PosixPath::try_new(points).map_err(|_| io::ErrorKind::InvalidInput)?;
    if mode != Mode::Optional && !input.is_absolute() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let initial = if input.is_absolute() {
        vec![47]
    } else {
        python_text(&std::env::current_dir()?)
    };
    // Path(str) folds dots/separators before realpath; symlink targets are
    // processed as returned by readlink, including their trailing separators.
    let pending: Vec<_> = input
        .codepoints()
        .split(|&point| point == 47)
        .rev()
        .map(|part| Pending::Component(part.to_vec()))
        .collect();
    Resolver {
        path: initial,
        remaining: pending.len(),
        pending,
        seen: BTreeMap::new(),
        mode,
    }
    .resolve()
}
impl Resolver {
    fn resolve(mut self) -> io::Result<PosixPath> {
        while let Some(step) = self.pending.pop() {
            match step {
                Pending::Cache(name) => {
                    self.seen.insert(name, Some(self.path.clone()));
                }
                Pending::Component(name) => {
                    self.remaining -= 1;
                    self.component(name)?;
                }
            }
        }
        PosixPath::try_new(&self.path).map_err(|_| io::ErrorKind::InvalidInput.into())
    }
    fn component(&mut self, name: Vec<u32>) -> io::Result<()> {
        if name.is_empty() || name == [46] {
            return Ok(());
        }
        if name == [46, 46] {
            let end = self
                .path
                .iter()
                .rposition(|&point| point == 47)
                .expect("absolute resolved path");
            self.path.truncate(end.max(1));
            return Ok(());
        }
        let mut candidate = self.path.clone();
        if candidate != [47] {
            candidate.push(47);
        }
        candidate.extend_from_slice(&name);
        // Python raises ValueError for NUL, not an ignored OSError. Likewise
        // surrogate encoding failures from python_path must remain failures.
        if candidate.contains(&0) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let native = python_path(&candidate)?;
        let metadata = match fs::symlink_metadata(&native) {
            Ok(value) => value,
            Err(error)
                if self.mode == Mode::Optional
                    || (self.mode == Mode::Future && error.kind() == io::ErrorKind::NotFound) =>
            {
                self.path = candidate;
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        if !metadata.file_type().is_symlink() {
            if self.mode != Mode::Optional && self.remaining > 0 && !metadata.is_dir() {
                return Err(io::Error::from_raw_os_error(libc::ENOTDIR));
            }
            self.path = candidate;
            return Ok(());
        }
        if let Some(target) = self.seen.get(&candidate) {
            self.path = match target {
                Some(target) => target.clone(),
                None if self.mode == Mode::Optional => candidate,
                None => return Err(io::Error::from_raw_os_error(libc::ELOOP)),
            };
            return Ok(());
        }
        let target = match fs::read_link(&native) {
            Ok(target) => python_text(&target),
            Err(_) if self.mode == Mode::Optional => {
                self.path = candidate;
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        self.seen.insert(candidate.clone(), None);
        self.pending.push(Pending::Cache(candidate));
        if target.first() == Some(&47) {
            self.path = vec![47];
        }
        let parts: Vec<_> = target
            .split(|&point| point == 47)
            .rev()
            .map(|part| Pending::Component(part.to_vec()))
            .collect();
        self.remaining += parts.len();
        self.pending.extend(parts);
        Ok(())
    }
}
