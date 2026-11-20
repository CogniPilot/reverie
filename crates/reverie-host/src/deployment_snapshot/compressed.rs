//! Publish a gzip copy whose complete decoded stream matches the rehearsed tar.
use super::{ConsoleSnapshot, Directory, Result, combine, deadline, manifest, mounts, require};
use flate2::{Compression, read::MultiGzDecoder, write::GzEncoder};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
    time::Instant,
};

impl ConsoleSnapshot {
    /// The destination is a new private directory on the durable backup filesystem.
    pub fn compressed_copy(
        &mut self,
        destination: &Path,
        end: Instant,
    ) -> Result<(PathBuf, String)> {
        require(self.restore_rehearsed(), "SNAPSHOT_REHEARSAL_REQUIRED")?;
        self.check_archive(end)?;
        let directory = Directory::create(destination)?;
        let result = (|| {
            mounts::disjoint(self.source.root.path(), directory.path(), &self.mounts)?;
            mounts::disjoint(self.destination.path(), directory.path(), &self.mounts)?;
            let file = directory.create_file("console.tar.gz")?;
            let result = self.compress_and_verify(&directory, &file, end);
            combine(result, crate::native::close(file).map_err(Into::into))
        })();
        combine(result, directory.close())
    }

    fn compress_and_verify(
        &self,
        directory: &Directory,
        file: &File,
        end: Instant,
    ) -> Result<(PathBuf, String)> {
        let mut source = &self.archive;
        source.rewind()?;
        let mut output = GzEncoder::new(file, Compression::fast());
        let expected = source.metadata()?.len();
        visit(&mut source, expected, end, |bytes| output.write_all(bytes))?;
        output.finish()?.sync_all()?;
        directory.sync()?;
        let mut input = file;
        input.rewind()?;
        let stamp = crate::native::Stamp::of(&file.metadata()?);
        let mut hash = Sha256::new();
        visit(&mut MultiGzDecoder::new(input), expected, end, |bytes| {
            hash.update(bytes);
            Ok(())
        })?;
        require(
            format!("{:x}", hash.finalize()) == self.digest,
            "SNAPSHOT_COMPRESSED_MISMATCH",
        )?;
        let checksum = manifest::file_digest(file, end)?;
        directory.check()?;
        directory.check_file("console.tar.gz", file)?;
        require(
            stamp == crate::native::Stamp::of(&file.metadata()?),
            "SNAPSHOT_ARCHIVE_CHANGED",
        )?;
        Ok((directory.path().join("console.tar.gz"), checksum))
    }
}

fn visit(
    reader: &mut impl Read,
    expected: u64,
    end: Instant,
    mut chunk: impl FnMut(&[u8]) -> std::io::Result<()>,
) -> Result<()> {
    let mut buffer = [0; 65_536];
    let mut bytes = 0_u64;
    loop {
        deadline(end)?;
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes = bytes.saturating_add(count as u64);
        require(bytes <= expected, "SNAPSHOT_ARCHIVE_CHANGED")?;
        chunk(&buffer[..count])?;
    }
    require(bytes == expected, "SNAPSHOT_ARCHIVE_CHANGED")
}
