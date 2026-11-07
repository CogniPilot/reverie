use crate::{Result, files, refused, tools::Tools};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

pub(crate) struct Libraries {
    index: BTreeMap<String, BTreeSet<PathBuf>>,
    pub(crate) selected: BTreeMap<String, PathBuf>,
}
impl Libraries {
    pub(crate) fn new(closure: &Path) -> Result<Self> {
        let mut index: BTreeMap<String, BTreeSet<PathBuf>> = BTreeMap::new();
        for line in fs::read_to_string(closure)?.lines() {
            let root = Path::new(line);
            if root.parent() != Some(Path::new("/nix/store")) || !root.exists() {
                return Err(refused("closure entries must be Nix store objects"));
            }
            index_libraries(root, &mut index)?;
        }
        Ok(Self {
            index,
            selected: BTreeMap::new(),
        })
    }
    fn resolve(&self, name: &str, source: &Path, tools: &Tools) -> Result<PathBuf> {
        if name.contains('/') {
            return crate::tools::immutable_input(Path::new(name));
        }
        let parent = source
            .parent()
            .ok_or_else(|| refused("ELF parent required"))?;
        for root in tools.patch(&["--print-rpath"], source)?.split(':') {
            let expanded = root
                .replace("${ORIGIN}", &parent.to_string_lossy())
                .replace("$ORIGIN", &parent.to_string_lossy());
            if expanded.is_empty() || expanded.contains('$') {
                continue;
            }
            let candidate = Path::new(&expanded).join(name);
            if candidate.is_file() {
                return crate::tools::immutable_input(&candidate);
            }
        }
        let candidates = self
            .index
            .get(name)
            .ok_or_else(|| refused(&format!("unclosed ELF dependency {name}")))?;
        let first = candidates
            .first()
            .ok_or_else(|| refused("empty library candidates"))?;
        let digest = files::digest(first)?;
        for other in candidates.iter().skip(1) {
            if files::digest(other)? != digest {
                return Err(refused(&format!("ambiguous library {name}")));
            }
        }
        Ok(first.clone())
    }
    pub(crate) fn include(&mut self, root: &Path, tools: &Tools) -> Result<()> {
        let mut pending = vec![root.to_owned()];
        let mut visited = BTreeSet::new();
        while let Some(source) = pending.pop() {
            if !visited.insert(source.clone()) || !tools.dynamic(&source)? {
                continue;
            }
            let needed = tools.patch(&["--print-needed"], &source)?;
            for name in needed.lines() {
                let resolved = self.resolve(name, &source, tools)?;
                let basename = Path::new(name)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .ok_or_else(|| refused("UTF8 library basename required"))?
                    .to_owned();
                self.select(basename, &resolved)?;
                // Equal bytes at another original path can have a different
                // $ORIGIN closure. Verify every source; visited bounds cycles.
                pending.push(resolved);
            }
            self.interpreter(&source, tools)?;
        }
        Ok(())
    }
    fn select(&mut self, name: String, resolved: &Path) -> Result<()> {
        if let Some(previous) = self.selected.get(&name) {
            if files::digest(previous)? != files::digest(resolved)? {
                return Err(refused("conflicting library contents in fixed capsule"));
            }
            return Ok(());
        }
        self.selected.insert(name, resolved.to_owned());
        Ok(())
    }
    fn interpreter(&mut self, source: &Path, tools: &Tools) -> Result<()> {
        let Some(interpreter) = tools.interpreter(source)? else {
            return Ok(());
        };
        let path = crate::tools::immutable_input(Path::new(&interpreter))?;
        let name = Path::new(&interpreter)
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(|| refused("interpreter basename required"))?;
        self.select(name.to_owned(), &path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;

fn index_libraries(root: &Path, index: &mut BTreeMap<String, BTreeSet<PathBuf>>) -> Result<()> {
    let mut pending = [root.join("lib"), root.join("lib64")]
        .into_iter()
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if entry.path().is_file() && entry.file_name().to_string_lossy().contains(".so")
            {
                index
                    .entry(entry.file_name().to_string_lossy().into_owned())
                    .or_default()
                    .insert(crate::tools::immutable_input(&entry.path())?);
            }
        }
    }
    Ok(())
}
