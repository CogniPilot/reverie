use crate::layout;
use serde::de::DeserializeOwned;
use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
};
use tar::Archive;

const MAX_JSON: u64 = 4 * 1024 * 1024;

struct Region {
    position: u64,
    length: u64,
}

pub(crate) struct SavedImage {
    file: File,
    members: BTreeMap<String, Region>,
}

pub(crate) fn malformed(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

impl SavedImage {
    pub(crate) fn open(file: File) -> io::Result<Self> {
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(malformed("expected a regular Docker archive"));
        }
        let mut archive = Archive::new(file);
        let members = index(&mut archive, metadata.len())?;
        Ok(Self {
            file: archive.into_inner(),
            members,
        })
    }

    fn member(&mut self, name: &str) -> io::Result<io::Take<&mut File>> {
        let region = self
            .members
            .get(layout::path(name))
            .ok_or_else(|| malformed("image member is missing"))?;
        self.file.seek(SeekFrom::Start(region.position))?;
        Ok((&mut self.file).take(region.length))
    }

    pub(crate) fn json<T: DeserializeOwned>(&mut self, name: &str) -> io::Result<T> {
        let mut member = self.member(name)?;
        if member.limit() > MAX_JSON {
            return Err(malformed("image metadata exceeds 4 MiB"));
        }
        let mut bytes = Vec::new();
        member.read_to_end(&mut bytes)?;
        if member.limit() != 0 {
            return Err(malformed("truncated image metadata"));
        }
        serde_json::from_slice(&bytes).map_err(|_| malformed("invalid image metadata JSON"))
    }

    pub(crate) fn layer(&mut self, name: &str) -> io::Result<Archive<Box<dyn Read + '_>>> {
        let mut reader = BufReader::new(self.member(name)?);
        let mut content: Box<dyn Read> = if reader.fill_buf()?.starts_with(&[0x1f, 0x8b]) {
            Box::new(flate2::read::MultiGzDecoder::new(reader))
        } else {
            Box::new(reader)
        };
        let mut header = [0; 512];
        content.read_exact(&mut header)?;
        Ok(Archive::new(Box::new(
            io::Cursor::new(header).chain(content),
        )))
    }
}

fn index(archive: &mut Archive<File>, length: u64) -> io::Result<BTreeMap<String, Region>> {
    let mut members = BTreeMap::new();
    for item in archive.entries_with_seek()? {
        let entry = item?;
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_contiguous() {
            continue;
        }
        let name = entry.path_bytes();
        let name =
            std::str::from_utf8(&name).map_err(|_| malformed("non-UTF-8 image member name"))?;
        let position = entry.raw_file_position();
        let size = entry.size();
        if size > length.saturating_sub(position) {
            return Err(malformed("truncated image member"));
        }
        let entry = Region {
            position,
            length: size,
        };
        if members
            .insert(layout::path(name).to_owned(), entry)
            .is_some()
        {
            return Err(malformed("duplicate image member"));
        }
    }
    Ok(members)
}
