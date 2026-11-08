//! A sealed packet: a directory whose `SHA256SUMS` lists every file in it, sealed by the leading
//! hex digits of the hash of `SHA256SUMS` itself. A packet is only read through a seal the caller
//! states, so a file changed, added or removed after review is refused.
use crate::sha256_hex;
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

/// Shortest seal accepted: 8 hex digits, the length reviewers quote.
pub const MIN_SEAL: usize = 8;

#[derive(Debug)]
pub struct Packet {
    dir: PathBuf,
    listed: BTreeSet<String>,
}

impl Packet {
    /// Verifies the seal, every listed hash, and that nothing unlisted is present.
    pub fn open(dir: &Path, seal: &str) -> Result<Self, String> {
        if seal.len() < MIN_SEAL || !seal.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!("a seal is at least {MIN_SEAL} hex digits"));
        }
        let sums = fs::read(dir.join("SHA256SUMS"))
            .map_err(|e| format!("{}: SHA256SUMS: {e}", dir.display()))?;
        if !sha256_hex(&sums).starts_with(&seal.to_ascii_lowercase()) {
            return Err("packet seal does not match SHA256SUMS".into());
        }
        let text = String::from_utf8(sums).map_err(|_| "SHA256SUMS is not UTF-8")?;
        let mut listed = BTreeSet::new();
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let (hash, name) = line
                .split_once(char::is_whitespace)
                .ok_or_else(|| format!("malformed SHA256SUMS line: {line}"))?;
            let name = name.trim_start().trim_start_matches('*');
            let name = name.strip_prefix("./").unwrap_or(name);
            if name.is_empty() || name.split('/').any(|part| part == ".." || part.is_empty()) {
                return Err(format!("unsafe path in SHA256SUMS: {name}"));
            }
            let bytes = fs::read(dir.join(name)).map_err(|e| format!("{name}: {e}"))?;
            if sha256_hex(&bytes) != hash.to_ascii_lowercase() {
                return Err(format!("{name}: hash does not match SHA256SUMS"));
            }
            listed.insert(name.to_owned());
        }
        let mut present = BTreeSet::new();
        files(dir, dir, &mut present).map_err(|e| format!("{}: {e}", dir.display()))?;
        present.remove("SHA256SUMS");
        let unlisted: Vec<_> = present.difference(&listed).cloned().collect();
        if !unlisted.is_empty() {
            return Err(format!("files not in SHA256SUMS: {}", unlisted.join(", ")));
        }
        Ok(Self {
            dir: dir.to_path_buf(),
            listed,
        })
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// The first of `names` the packet lists.
    pub fn first_of<'n>(&self, names: &[&'n str]) -> Option<&'n str> {
        names
            .iter()
            .copied()
            .find(|name| self.listed.contains(*name))
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
                    fs::read_to_string(self.path(name)).map_err(|e| format!("{name}: {e}"))
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

    /// `source.bundle`, else the packet's only `.bundle`.
    pub fn bundle(&self) -> Result<PathBuf, String> {
        if self.listed.contains("source.bundle") {
            return Ok(self.path("source.bundle"));
        }
        let bundles: Vec<_> = self
            .listed
            .iter()
            .filter(|name| name.ends_with(".bundle"))
            .collect();
        match bundles.as_slice() {
            [only] => Ok(self.path(only)),
            [] => Err("the packet has no bundle".into()),
            _ => Err("the packet has several bundles and no source.bundle".into()),
        }
    }
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
