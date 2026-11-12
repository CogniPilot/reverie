//! Streaming metadata-only archive reads from one held immutable input.
//! A raw pass bounds extended headers BEFORE tar's logical iterator allocates
//! them. No file is extracted, and no layer-content/privacy proof is produced.
use crate::build_input::{self as input, Result, need};
use flate2::read::MultiGzDecoder;
use reverie_contracts::resource_actor::{WebsiteArchiveConfiguration, WebsiteArchiveManifest};
use reverie_core::PythonText;
use std::{
    collections::BTreeSet,
    fs::File,
    io::{self, Read, Seek},
    path::Path,
    time::Instant,
};
const MAX_JSON: u64 = 4 << 20;
const MAX_UNPACKED: u64 = 64 << 30;
const MAX_EXTENSIONS: u64 = 8 << 20;

pub(super) fn configuration(path: &Path, end: Instant) -> Result<WebsiteArchiveConfiguration> {
    input::with(
        path,
        16 << 30,
        false,
        |file| Ok(held_metadata(file, end)?.0),
    )
}
pub(super) fn held_metadata(
    file: &mut File,
    end: Instant,
) -> Result<(WebsiteArchiveConfiguration, WebsiteArchiveManifest)> {
    let mut archive = stream(file, end)?;
    check_extensions(&mut archive)?;
    drain(archive)?;
    let (manifest, regular) = census(file, end)?;
    let selected = WebsiteArchiveManifest::decode(&manifest, &regular)?;
    let raw = selected_config(file, selected.config_member().as_bytes(), end)?;
    Ok((
        WebsiteArchiveConfiguration::decode(&raw, &selected)?,
        selected,
    ))
}
pub(super) fn stream(
    file: &mut File,
    end: Instant,
) -> Result<tar::Archive<Bounded<Box<dyn Read + '_>>>> {
    file.rewind()?;
    let mut magic = [0_u8; 2];
    file.read_exact(&mut magic)?;
    file.rewind()?;
    let reader: Box<dyn Read + '_> = if magic == [0x1f, 0x8b] {
        Box::new(MultiGzDecoder::new(file))
    } else {
        Box::new(file)
    };
    Ok(tar::Archive::new(Bounded {
        reader,
        count: 0,
        end,
    }))
}
pub(super) fn check_extensions(archive: &mut tar::Archive<impl Read>) -> Result<()> {
    let mut extensions = 0_u64;
    for entry in archive.entries()?.raw(true) {
        let mut entry = entry?;
        let kind = entry.header().entry_type();
        need(
            !kind.is_gnu_sparse() && !kind.is_pax_global_extensions(),
            "WEBSITE_BUILD_FIXED_FACTORY_TAR_FORMAT",
        )?;
        if kind.is_gnu_longname() || kind.is_gnu_longlink() || kind.is_pax_local_extensions() {
            let size = entry.size();
            extensions = extensions
                .checked_add(size)
                .ok_or("WEBSITE_BUILD_EXTENSION_BOUND")?;
            need(
                size <= MAX_JSON && extensions <= MAX_EXTENSIONS,
                "WEBSITE_BUILD_EXTENSION_BOUND",
            )?;
            if kind.is_pax_local_extensions() {
                // Size-changing PAX and sparse records alter physical offsets,
                // so a raw prepass cannot vouch for their logical allocation
                // bounds. Fixed Nix factory archives do not need those forms.
                check_pax(&mut entry)?;
            }
        }
        io::copy(&mut entry, &mut io::sink())?;
    }
    Ok(())
}
fn check_pax(entry: &mut tar::Entry<'_, impl Read>) -> Result<()> {
    let mut seen = BTreeSet::new();
    if let Some(fields) = entry.pax_extensions()? {
        for field in fields {
            let field = field?;
            let key = field.key_bytes();
            need(
                key != b"size" && !key.starts_with(b"GNU.sparse") && seen.insert(key.to_vec()),
                "WEBSITE_BUILD_FIXED_FACTORY_PAX_FORMAT",
            )?;
        }
    }
    Ok(())
}
fn census(file: &mut File, end: Instant) -> Result<(Vec<u8>, Vec<PythonText>)> {
    let mut archive = stream(file, end)?;
    let mut seen = BTreeSet::new();
    let mut regular = Vec::new();
    let mut manifest = None;
    for entry in archive.entries()? {
        let mut entry = entry?;
        let name = entry.path_bytes().into_owned();
        canonical(&name)?;
        need(
            seen.len() < 4096 && seen.insert(name.clone()),
            "WEBSITE_BUILD_DUPLICATE_OR_EXCESSIVE_MEMBER",
        )?;
        if regular_entry(entry.header().entry_type()) {
            regular.push(python_name(&name));
        }
        if name == b"manifest.json" || is_configuration(&name) {
            need(
                regular_entry(entry.header().entry_type())
                    && entry.size() > 0
                    && entry.size() <= MAX_JSON,
                "WEBSITE_BUILD_METADATA_REGULAR_BOUND",
            )?;
            if name == b"manifest.json" {
                manifest = Some(read_metadata(&mut entry)?);
            }
        }
        io::copy(&mut entry, &mut io::sink())?;
    }
    drain(archive)?;
    Ok((manifest.ok_or("WEBSITE_BUILD_MANIFEST_REQUIRED")?, regular))
}
fn selected_config(file: &mut File, name: &[u8], end: Instant) -> Result<Vec<u8>> {
    let mut archive = stream(file, end)?;
    let mut selected = None;
    for entry in archive.entries()? {
        let mut entry = entry?;
        if entry.path_bytes() == name {
            selected = Some(read_metadata(&mut entry)?);
        }
        io::copy(&mut entry, &mut io::sink())?;
    }
    drain(archive)?;
    selected.ok_or_else(|| "WEBSITE_BUILD_CONFIG_UNAVAILABLE".into())
}
fn read_metadata(entry: &mut tar::Entry<'_, impl Read>) -> Result<Vec<u8>> {
    need(
        regular_entry(entry.header().entry_type()) && entry.size() > 0 && entry.size() <= MAX_JSON,
        "WEBSITE_BUILD_METADATA_REGULAR_BOUND",
    )?;
    let expected = entry.size();
    let mut raw = Vec::new();
    entry.take(MAX_JSON + 1).read_to_end(&mut raw)?;
    need(
        raw.len() as u64 == expected,
        "WEBSITE_BUILD_METADATA_LENGTH",
    )?;
    Ok(raw)
}
fn is_configuration(name: &[u8]) -> bool {
    name.strip_suffix(b".json").is_some_and(|v| {
        v.len() == 64
            && v.iter()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
    })
}
fn canonical(name: &[u8]) -> Result<()> {
    // Only trailing slash is ignored by the original PurePosixPath check;
    // whitespace and backslash remain literal path bytes.
    let last = name.iter().rposition(|b| *b != b'/').map_or(0, |v| v + 1);
    let path = &name[..last];
    need(
        !name.starts_with(b"/")
            && !path.is_empty()
            && (path == b"."
                || path
                    .split(|b| *b == b'/')
                    .all(|v| !v.is_empty() && v != b"." && v != b"..")),
        "WEBSITE_BUILD_CANONICAL_MEMBER",
    )
}
pub(super) fn regular_entry(kind: tar::EntryType) -> bool {
    kind.is_file() || kind.is_contiguous()
}
pub(super) fn python_name(raw: &[u8]) -> PythonText {
    PythonText::try_new(reverie_core::posix_text::decode(raw)).expect("filesystem codepoints")
}
pub(super) fn drain<R: Read>(archive: tar::Archive<R>) -> Result<()> {
    io::copy(&mut archive.into_inner(), &mut io::sink())?;
    Ok(())
}
pub(super) struct Bounded<R> {
    reader: R,
    count: u64,
    end: Instant,
}
impl<R: Read> Read for Bounded<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if Instant::now() >= self.end {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "WEBSITE_BUILD_ARCHIVE_DEADLINE",
            ));
        }
        let maximum = output.len().min(65536);
        let n = self.reader.read(&mut output[..maximum])?;
        self.count = self
            .count
            .checked_add(n as u64)
            .ok_or(io::ErrorKind::InvalidData)?;
        if self.count > MAX_UNPACKED {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "WEBSITE_BUILD_ARCHIVE_EXPANDED_BOUND",
            ));
        }
        Ok(n)
    }
}
