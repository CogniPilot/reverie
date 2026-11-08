//! A sealed packet: a directory whose `SHA256SUMS` lists every file in it, sealed by the leading
//! hex digits of the hash of `SHA256SUMS` itself. A packet is only read through a seal the caller
//! states, so a file changed, added or removed after review is refused. Every file read must be a
//! regular file reached without a symlink in any component, so nothing outside the sealed
//! directory can stand in for a payload, or change after the check.
use crate::sha256_hex;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

/// Shortest seal accepted: 8 hex digits, the length reviewers quote.
pub const MIN_SEAL: usize = 8;

#[derive(Debug)]
pub struct Packet {
    dir: PathBuf,
    /// Each listed file and its sealed hash.
    listed: BTreeMap<String, String>,
}

impl Packet {
    /// Verifies the seal, every listed hash, and that nothing unlisted is present.
    pub fn open(dir: &Path, seal: &str) -> Result<Self, String> {
        if seal.len() < MIN_SEAL || !seal.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!("a seal is at least {MIN_SEAL} hex digits"));
        }
        let sums = read_regular(dir, "SHA256SUMS")?;
        if !sha256_hex(&sums).starts_with(&seal.to_ascii_lowercase()) {
            return Err("packet seal does not match SHA256SUMS".into());
        }
        let text = String::from_utf8(sums).map_err(|_| "SHA256SUMS is not UTF-8")?;
        let mut listed = BTreeMap::new();
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let (hash, name) = line
                .split_once(char::is_whitespace)
                .ok_or_else(|| format!("malformed SHA256SUMS line: {line}"))?;
            let name = name.trim_start().trim_start_matches('*');
            let name = name.strip_prefix("./").unwrap_or(name);
            if name.is_empty() || name.split('/').any(|part| part == ".." || part.is_empty()) {
                return Err(format!("unsafe path in SHA256SUMS: {name}"));
            }
            let bytes = read_regular(dir, name)?;
            if sha256_hex(&bytes) != hash.to_ascii_lowercase() {
                return Err(format!("{name}: hash does not match SHA256SUMS"));
            }
            listed.insert(name.to_owned(), hash.to_ascii_lowercase());
        }
        let mut present = BTreeSet::new();
        files(dir, dir, &mut present).map_err(|e| format!("{}: {e}", dir.display()))?;
        present.remove("SHA256SUMS");
        let unlisted: Vec<_> = present
            .iter()
            .filter(|name| !listed.contains_key(*name))
            .cloned()
            .collect();
        if !unlisted.is_empty() {
            return Err(format!("files not in SHA256SUMS: {}", unlisted.join(", ")));
        }
        Ok(Self {
            dir: dir.to_path_buf(),
            listed,
        })
    }

    /// Reads a listed file again, refusing it unless it still matches its sealed hash.
    pub fn read(&self, name: &str) -> Result<Vec<u8>, String> {
        let sealed = self
            .listed
            .get(name)
            .ok_or_else(|| format!("{name} is not in the packet"))?;
        let bytes = read_regular(&self.dir, name)?;
        if &sha256_hex(&bytes) != sealed {
            return Err(format!("{name} changed after the packet was opened"));
        }
        Ok(bytes)
    }

    /// The first of `names` the packet lists.
    pub fn first_of<'n>(&self, names: &[&'n str]) -> Option<&'n str> {
        names
            .iter()
            .copied()
            .find(|name| self.listed.contains_key(*name))
    }

    /// The PR title (first line) and body, from `TITLE.txt`/`PR-TITLE.txt` and
    /// `BODY.md`/`PR-BODY.md`/`PR_BODY.md`, when the packet carries both.
    pub fn text(&self) -> Result<Option<(String, String)>, String> {
        let title = self.first_of(&["TITLE.txt", "PR-TITLE.txt"]);
        let body = self.first_of(&["BODY.md", "PR-BODY.md", "PR_BODY.md"]);
        match (title, body) {
            (None, None) => Ok(None),
            (Some(title), Some(body)) => {
                let read = |name: &str| {
                    String::from_utf8(self.read(name)?).map_err(|_| format!("{name} is not UTF-8"))
                };
                let title = read(title)?;
                let title = title.lines().next().unwrap_or("").trim().to_owned();
                if title.is_empty() {
                    return Err("the title is empty".into());
                }
                Ok(Some((title, read(body)?)))
            }
            _ => Err("a packet carries a title and a body together, or neither".into()),
        }
    }

    /// The bundle's bytes, re-checked against the seal: `source.bundle`, else the packet's only
    /// `.bundle`.
    pub fn bundle(&self) -> Result<Vec<u8>, String> {
        if self.listed.contains_key("source.bundle") {
            return self.read("source.bundle");
        }
        let bundles: Vec<_> = self
            .listed
            .keys()
            .filter(|name| name.ends_with(".bundle"))
            .collect();
        match bundles.as_slice() {
            [only] => self.read(only),
            [] => Err("the packet has no bundle".into()),
            _ => Err("the packet has several bundles and no source.bundle".into()),
        }
    }
}

/// Reads `name` under `dir` only if no component of it is a symlink and it is a regular file; the
/// open itself refuses a symlink (`O_NOFOLLOW`), so a swap after the check fails too.
pub fn read_regular(dir: &Path, name: &str) -> Result<Vec<u8>, String> {
    use std::{io::Read, os::unix::fs::OpenOptionsExt};
    let mut path = dir.to_path_buf();
    for part in name.split('/') {
        path.push(part);
        let meta = fs::symlink_metadata(&path).map_err(|e| format!("{name}: {e}"))?;
        if meta.file_type().is_symlink() {
            return Err(format!("{name}: a symlink in the packet is refused"));
        }
    }
    if !fs::symlink_metadata(&path)
        .map_err(|e| format!("{name}: {e}"))?
        .is_file()
    {
        return Err(format!("{name}: only regular files are read from a packet"));
    }
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|e| format!("{name}: {e}"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("{name}: {e}"))?;
    Ok(bytes)
}

fn files(root: &Path, dir: &Path, out: &mut BTreeSet<String>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            files(root, &path, out)?;
        } else {
            let relative = path.strip_prefix(root).unwrap_or(&path);
            out.insert(relative.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_changed_after_opening_is_refused_on_a_later_read() {
        let dir = std::env::temp_dir().join(format!("publish-reread-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("BODY.md"), "reviewed\n").unwrap();
        let sums = format!("{}  BODY.md\n", sha256_hex(b"reviewed\n"));
        fs::write(dir.join("SHA256SUMS"), &sums).unwrap();
        let packet = Packet::open(&dir, &sha256_hex(sums.as_bytes())[..8]).unwrap();
        fs::write(dir.join("BODY.md"), "edited after the check\n").unwrap();
        let error = packet.read("BODY.md").unwrap_err();
        assert!(
            error.contains("changed after the packet was opened"),
            "{error}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_listed_path_that_leaves_the_packet_refuses() {
        let dir = std::env::temp_dir().join(format!("publish-packet-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let sums = format!("{}  ../outside.txt\n", sha256_hex(b""));
        fs::write(dir.join("SHA256SUMS"), &sums).unwrap();
        let seal = &sha256_hex(sums.as_bytes())[..8];
        let error = Packet::open(&dir, seal).unwrap_err();
        assert!(error.contains("unsafe path"), "{error}");
        assert!(
            Packet::open(&dir, "abc")
                .unwrap_err()
                .contains("at least 8")
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
