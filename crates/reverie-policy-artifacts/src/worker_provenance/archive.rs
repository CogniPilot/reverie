use super::{Result, build_archive, input, layers, need};
use reverie_contracts::resource_actor::{CodeFile, WorkerImageProvenanceBuild};
use reverie_core::operations::JournalDigest;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, Read, Seek},
    path::Path,
    time::Instant,
};

pub(super) fn preflight_layers(file: &mut File, end: Instant) -> Result<()> {
    let mut outer = build_archive::stream(file, end)?;
    for member in outer.entries()? {
        let mut member = member?;
        let name = layers::canonical(&member.path_bytes())?;
        if name.ends_with(b"/layer.tar") {
            need(
                build_archive::regular_entry(member.header().entry_type())
                    && member.size() > 0
                    && member.size() <= 64 << 30,
                "WORKER_BUILD_REGULAR_LAYER_BOUND",
            )?;
            let mut reader = Hashing::new(&mut member, 64 << 30, end);
            let mut archive = tar::Archive::new(&mut reader);
            build_archive::check_extensions(&mut archive)?;
            build_archive::drain(archive)?;
        }
        io::copy(&mut member, &mut io::sink())?;
    }
    build_archive::drain(outer)
}
pub(super) fn layers(
    file: &mut File,
    build: &WorkerImageProvenanceBuild,
    end: Instant,
) -> Result<BTreeMap<Vec<u8>, layers::Layer>> {
    let mut outer = build_archive::stream(file, end)?;
    let mut seen = std::collections::BTreeSet::new();
    let mut selected = BTreeMap::new();
    let mut budget = 2_000_000_usize;
    for member in outer.entries()? {
        let mut member = member?;
        let name = layers::canonical(&member.path_bytes())?;
        need(
            seen.len() < 4096 && seen.insert(name.clone()),
            "WORKER_BUILD_DUPLICATE_OUTER_MEMBER",
        )?;
        if name.ends_with(b"/layer.tar") {
            need(
                build_archive::regular_entry(member.header().entry_type())
                    && member.size() > 0
                    && member.size() <= 64 << 30,
                "WORKER_BUILD_REGULAR_LAYER_BOUND",
            )?;
            let size = member.size();
            let mut reader = Hashing::new(&mut member, size, end);
            let mut layer = layers::read(&mut reader, build.toolkit_files(), &mut budget)?;
            io::copy(&mut reader, &mut io::sink())?;
            need(reader.count == size, "WORKER_BUILD_LAYER_LENGTH")?;
            layer.digest = reader.digest();
            selected.insert(name, layer);
        }
        io::copy(&mut member, &mut io::sink())?;
    }
    build_archive::drain(outer)?;
    Ok(selected)
}
pub(super) fn compressed_pin(file: &mut File, path: &Path, end: Instant) -> Result<CodeFile> {
    let bytes = file.metadata()?.len();
    file.rewind()?;
    let mut reader = Hashing::new(file, 16 << 30, end);
    io::copy(&mut reader, &mut io::sink())?;
    need(reader.count == bytes, "WORKER_BUILD_ARCHIVE_LENGTH")?;
    Ok(CodeFile {
        path: input::text(path)?,
        sha256: JournalDigest::parse(&reader.digest())?,
        bytes,
    })
}
struct Hashing<R> {
    reader: R,
    count: u64,
    maximum: u64,
    end: Instant,
    hash: Sha256,
}
impl<R> Hashing<R> {
    fn new(reader: R, maximum: u64, end: Instant) -> Self {
        Self {
            reader,
            count: 0,
            maximum,
            end,
            hash: Sha256::new(),
        }
    }
    fn digest(&self) -> String {
        format!("{:x}", self.hash.clone().finalize())
    }
}
impl<R: Read> Read for Hashing<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if Instant::now() >= self.end {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "WORKER_BUILD_ARCHIVE_DEADLINE",
            ));
        }
        let maximum = output.len().min(1 << 20);
        let n = self.reader.read(&mut output[..maximum])?;
        self.count = self
            .count
            .checked_add(n as u64)
            .ok_or(io::ErrorKind::InvalidData)?;
        if self.count > self.maximum {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "WORKER_BUILD_HASHED_READ_BOUND",
            ));
        }
        self.hash.update(&output[..n]);
        Ok(n)
    }
}
