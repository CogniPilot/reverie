//! _lease_path_candidates: only actual canonical laptop mounts translate guest
//! paths. An absolute guest link never becomes an arbitrary host-root lookup.
use super::super::*;
use reverie_contracts::worker_cold_tmp::ColdConfiguration;
#[cfg(test)]
mod tests;
pub(in crate::worker_storage::cold_tmp) struct Mappings {
    entries: Vec<(PosixPath, PosixPath)>,
}
impl Mappings {
    pub(in crate::worker_storage::cold_tmp) fn capture(
        config: &Configuration,
        paths: &StoragePaths,
        policy: &ColdConfiguration,
    ) -> Result<Self> {
        let original = super::super::super::temporary::path_text(config, paths)?;
        let mut entries = vec![
            (
                PosixPath::from_scalar_text("/tmp"),
                original.scratch().join(&PosixPath::from_scalar_text("tmp")),
            ),
            (
                PosixPath::from_scalar_text("/scratch"),
                original.scratch().clone(),
            ),
            (
                PosixPath::from_scalar_text("/home/agent"),
                original.home().clone(),
            ),
            (PosixPath::from_scalar_text("/nix"), original.nix().clone()),
        ];
        for mount in policy
            .mounts()
            .map_err(|_| StorageError::Refused(StorageFault::ColdLease))?
        {
            let selected = mount
                .source()
                .map_err(|_| StorageError::Refused(StorageFault::ColdLease))?;
            let destination = mount
                .destination()
                .map_err(|_| StorageError::Refused(StorageFault::ColdLease))?;
            entries.push((
                PosixPath::try_new(destination.codepoints())
                    .map_err(|_| StorageError::Refused(StorageFault::ColdLease))?,
                native::resolve_strict_text(selected.codepoints())?,
            ));
        }
        if !entries
            .iter()
            .any(|(dest, _)| *dest == PosixPath::from_scalar_text("/workspace"))
        {
            let shared = entries
                .iter()
                .filter(|(dest, _)| *dest == PosixPath::from_scalar_text("/reverie_workspace"))
                .map(|(_, source)| source.clone())
                .collect::<Vec<_>>();
            if let [source] = shared.as_slice() {
                entries.push((PosixPath::from_scalar_text("/workspace"), source.clone()));
            }
        }
        Ok(Self { entries })
    }
    pub(in crate::worker_storage::cold_tmp) fn candidates(
        &self,
        recorded: &PosixPath,
        key: &str,
        end: Instant,
    ) -> Result<Vec<PosixPath>> {
        check(end)?;
        let mut candidates = Vec::new();
        if let Ok(host) = native::resolve_strict_text(&recorded.codepoints()) {
            candidates.push(host);
        }
        match self.guest(recorded, end) {
            Ok(Some(path)) => candidates.push(path),
            Ok(None) => {}
            Err(StorageError::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound
                        | std::io::ErrorKind::NotADirectory
                        | std::io::ErrorKind::PermissionDenied
                ) => {}
            Err(error) => return Err(error),
        }
        let mut found = Vec::new();
        for candidate in candidates {
            check(end)?;
            if found.contains(&candidate) {
                continue;
            }
            let Ok(native) = native::python_path(&candidate.codepoints()) else {
                continue;
            };
            let Ok(info) = std::fs::symlink_metadata(native) else {
                continue;
            };
            if info.is_dir() && format!("{}-{}", info.dev(), info.ino()) == key {
                found.push(candidate);
            }
        }
        Ok(found)
    }
    fn guest(&self, recorded: &PosixPath, end: Instant) -> Result<Option<PosixPath>> {
        let mut guest = recorded.clone();
        let mut links = 0;
        loop {
            check(end)?;
            let matched = self
                .entries
                .iter()
                .filter(|(dest, _)| guest.is_relative_to(dest))
                .collect::<Vec<_>>();
            let Some(depth) = matched
                .iter()
                .map(|(dest, _)| dest.components().len())
                .max()
            else {
                return Ok(None);
            };
            let deepest = matched
                .into_iter()
                .filter(|(dest, _)| dest.components().len() == depth)
                .collect::<Vec<_>>();
            need(deepest.len() == 1, StorageFault::ColdLease)?;
            let (destination, source) = deepest[0];
            let relative = guest
                .relative_to(destination)
                .expect("matched guest prefix");
            need(relative.components().len() <= 256, StorageFault::ColdBound)?;
            match Self::follow(source, destination, &relative, &mut links, end)? {
                Follow::Complete(path) => {
                    return native::resolve_strict_text(&path.codepoints())
                        .map(Some)
                        .map_err(Into::into);
                }
                Follow::Restart(path) => guest = path,
            }
        }
    }
    fn follow(
        source: &PosixPath,
        destination: &PosixPath,
        relative: &PosixPath,
        links: &mut usize,
        end: Instant,
    ) -> Result<Follow> {
        let parts = relative.components().collect::<Vec<_>>();
        let mut current = source.clone();
        let mut logical = destination.clone();
        for (index, part) in parts.iter().enumerate() {
            check(end)?;
            let part = PosixPath::try_new(part).expect("checked components");
            current = current.join(&part);
            logical = logical.join(&part);
            let native = native::python_path(&current.codepoints())?;
            if !std::fs::symlink_metadata(&native)?.file_type().is_symlink() {
                continue;
            }
            *links += 1;
            need(*links <= 40, StorageFault::ColdBound)?;
            return restart(&logical, std::fs::read_link(&native)?, &parts[index + 1..])
                .map(Follow::Restart);
        }
        Ok(Follow::Complete(current))
    }
}
fn restart(logical: &PosixPath, target: PathBuf, tail: &[&[u32]]) -> Result<PosixPath> {
    let target = PosixPath::try_new(&native::python_text(&target)).expect("filesystem codepoints");
    let next = if target.is_absolute() {
        target
    } else {
        logical.parent().join(&target)
    };
    let mut normalized = Vec::new();
    for component in next.components() {
        if component == [46, 46] {
            need(!normalized.is_empty(), StorageFault::ColdLease)?;
            normalized.pop();
        } else {
            normalized.push(component.to_vec());
        }
    }
    let path = normalized
        .iter()
        .map(Vec::as_slice)
        .chain(tail.iter().copied())
        .fold(PosixPath::from_scalar_text("/"), |path, component| {
            path.join(&PosixPath::try_new(component).expect("checked guest components"))
        });
    Ok(path)
}
enum Follow {
    Complete(PosixPath),
    Restart(PosixPath),
}
