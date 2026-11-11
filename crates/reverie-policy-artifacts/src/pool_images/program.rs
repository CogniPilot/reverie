//! Bind the selected executable to the actual factory image bytes and entry link.
use super::{
    archive::Archive,
    error::{Error, Result, finalized, need},
    metadata,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::File,
    io::{self, Read, Seek},
    path::{Component, Path},
    time::Instant,
};

const ENTRY: &str = "bin/reverie-worker-resource-controller";
const MAX_PROGRAM: u64 = 64 * 1024 * 1024;
#[cfg(test)]
mod tests;

pub(super) fn measure(
    image: &Path,
    program: &Path,
    expected_archive_digest: &str,
    end: Instant,
) -> Result<serde_json::Value> {
    need(
        program.canonicalize()? == program
            && program.starts_with("/nix/store")
            && program.ends_with(ENTRY),
        "POOL_IMAGE_PROGRAM_PATH",
    )?;
    let mut executable = Archive::open(program, end)?;
    let body = (|| {
        need(
            executable.bytes() <= MAX_PROGRAM,
            "POOL_IMAGE_PROGRAM_BOUND",
        )?;
        let mut image = Archive::open(image, end)?;
        let checked = (|| {
            need(
                image.digest() == expected_archive_digest,
                "POOL_IMAGE_PROGRAM_ARCHIVE_CHANGED",
            )?;
            let manifest = metadata::manifest(&image.metadata("manifest.json")?)?;
            image.verify_program(
                &manifest.layers,
                program,
                executable.digest(),
                executable.bytes(),
            )
        })();
        finalized(checked, image.close())?;
        executable.assert_current()?;
        Ok(
            serde_json::json!({"path":executable.path()?,"sha256":executable.digest(),"bytes":executable.bytes()}),
        )
    })();
    finalized(body, executable.close())
}

struct Bounded<R> {
    source: R,
    left: u64,
    end: Instant,
}
impl<R: Read> Read for Bounded<R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if Instant::now() >= self.end {
            return Err(io::Error::other("POOL_IMAGE_PROGRAM_DEADLINE"));
        }
        let count = self.source.read(bytes)?;
        self.left = self
            .left
            .checked_sub(count as u64)
            .ok_or_else(|| io::Error::other("POOL_IMAGE_PROGRAM_ARCHIVE_BOUND"))?;
        Ok(count)
    }
}
fn name(path: &Path) -> Result<String> {
    let mut names = Vec::new();
    for part in path.components() {
        match part {
            Component::CurDir => (),
            Component::Normal(value) => names.push(
                value
                    .to_str()
                    .ok_or(Error::Refused("POOL_IMAGE_PROGRAM_UTF8"))?,
            ),
            _ => return Err(Error::Refused("POOL_IMAGE_PROGRAM_MEMBER")),
        }
    }
    Ok(names.join("/"))
}

struct Witness<'a> {
    path: &'a Path,
    target: String,
    digest: &'a str,
    bytes: u64,
    file: bool,
    entry: bool,
}
impl Witness<'_> {
    fn layer(&mut self, source: impl Read, end: Instant) -> Result<()> {
        let mut archive = tar::Archive::new(Bounded {
            source,
            left: 512 * 1024 * 1024,
            end,
        });
        for entry in archive.entries()? {
            need(Instant::now() < end, "POOL_IMAGE_PROGRAM_DEADLINE")?;
            let mut entry = entry?;
            let path = entry.path()?;
            // dockerTools writes absolute store members. Compare their image-root
            // names without extracting; traversal and normalized duplicates still refuse.
            let name = name(path.strip_prefix("/").unwrap_or(&path))?;
            need(
                !name.is_empty() || entry.header().entry_type().is_dir(),
                "POOL_IMAGE_PROGRAM_PARENT",
            )?;
            need(
                !name.split('/').any(|part| part.starts_with(".wh.")),
                "POOL_IMAGE_PROGRAM_WHITEOUT",
            )?;
            if name == self.target {
                need(
                    !self.file
                        && entry.header().entry_type().is_file()
                        && entry.size() == self.bytes,
                    "POOL_IMAGE_PROGRAM_MEMBER",
                )?;
                verify_elf(&mut entry, self.digest, end)?;
                self.file = true;
            } else if name == ENTRY {
                need(
                    !self.entry
                        && entry.header().entry_type().is_symlink()
                        && entry.link_name()?.as_deref() == Some(self.path),
                    "POOL_IMAGE_PROGRAM_ENTRY",
                )?;
                self.entry = true;
            } else if !name.is_empty()
                && (self.target.starts_with(&format!("{name}/"))
                    || ENTRY.starts_with(&format!("{name}/")))
            {
                need(
                    entry.header().entry_type().is_dir(),
                    "POOL_IMAGE_PROGRAM_PARENT",
                )?;
            }
        }
        Ok(())
    }
}

fn verify_elf(entry: &mut impl Read, digest: &str, end: Instant) -> Result<()> {
    let mut hash = Sha256::new();
    let mut magic = Vec::new();
    let mut bytes = [0; 16_384];
    loop {
        need(Instant::now() < end, "POOL_IMAGE_PROGRAM_DEADLINE")?;
        let count = entry.read(&mut bytes)?;
        if count == 0 {
            break;
        }
        if magic.len() < 4 {
            magic.extend_from_slice(&bytes[..count.min(4 - magic.len())]);
        }
        hash.update(&bytes[..count]);
    }
    need(
        magic == b"\x7fELF" && format!("{:x}", hash.finalize()) == digest,
        "POOL_IMAGE_PROGRAM_DIGEST",
    )
}

pub(super) fn verify(
    file: &mut File,
    layers: &[String],
    program: &Path,
    digest: &str,
    bytes: u64,
    end: Instant,
) -> Result<()> {
    file.rewind()?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(Bounded {
        source: decoder,
        left: 2 * 1024 * 1024 * 1024,
        end,
    });
    let selected: BTreeSet<_> = layers.iter().collect();
    let mut seen = BTreeSet::new();
    let target = program
        .strip_prefix("/")
        .map_err(|_| Error::Refused("POOL_IMAGE_PROGRAM_PATH"))?;
    let mut witness = Witness {
        path: program,
        target: name(target)?,
        digest,
        bytes,
        file: false,
        entry: false,
    };
    for entry in archive.entries()? {
        need(Instant::now() < end, "POOL_IMAGE_PROGRAM_DEADLINE")?;
        let entry = entry?;
        let name = name(&entry.path()?)?;
        if selected.contains(&name) {
            need(
                seen.insert(name) && entry.header().entry_type().is_file(),
                "POOL_IMAGE_PROGRAM_LAYER",
            )?;
            witness.layer(entry, end)?;
        }
    }
    need(
        seen.len() == layers.len() && witness.file && witness.entry,
        "POOL_IMAGE_PROGRAM_MISSING",
    )
}
