//! Read-only Nix build custody. Namespace mapping is derived from the actual
//! root/store metadata, never from a caller-selected UID or environment value.
use crate::output;
use reverie_contracts::resource_actor::CodeFile;
use reverie_core::{PythonText, operations::JournalDigest};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    os::unix::{
        ffi::{OsStrExt, OsStringExt},
        fs::{MetadataExt, OpenOptionsExt},
    },
    path::Path,
    time::Instant,
};
pub(super) type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
pub(super) fn need(value: bool, reason: &'static str) -> Result<()> {
    if value { Ok(()) } else { Err(reason.into()) }
}

fn stamp(m: &Metadata) -> (u64, u64, u64, i64, i64, i64, i64) {
    (
        m.dev(),
        m.ino(),
        m.len(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    )
}
pub(super) fn with<T>(
    path: &Path,
    maximum: u64,
    empty: bool,
    body: impl FnOnce(&mut File) -> Result<T>,
) -> Result<T> {
    need(
        path.is_absolute() && path.starts_with("/nix/store") && path.canonicalize()? == path,
        "WEBSITE_BUILD_CANONICAL_NIX_INPUT",
    )?;
    let store = fs::metadata("/nix/store")?;
    need(
        store.is_dir() && store.uid() == fs::metadata("/")?.uid(),
        "WEBSITE_BUILD_ROOT_STORE_OWNER",
    )?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let result = (|| {
        let before = file.metadata()?;
        need(
            before.is_file()
                && before.uid() == store.uid()
                && before.mode() & 0o222 == 0
                && (empty || before.len() > 0)
                && before.len() <= maximum,
            "WEBSITE_BUILD_INPUT_CUSTODY_OR_BOUND",
        )?;
        let result = body(&mut file);
        let current = (|| {
            need(
                stamp(&file.metadata()?) == stamp(&before)
                    && stamp(&fs::symlink_metadata(path)?) == stamp(&before)
                    && path.canonicalize()? == path,
                "WEBSITE_BUILD_INPUT_CHANGED",
            )
        })();
        combine(result, current)
    })();
    combine(result, output::close(file).map_err(Into::into))
}
pub(super) fn read(path: &Path, maximum: usize, end: Instant) -> Result<Vec<u8>> {
    with(path, maximum as u64, false, |file| {
        need(Instant::now() < end, "WEBSITE_BUILD_INPUT_DEADLINE")?;
        let mut bytes = Vec::new();
        (&mut *file)
            .take(maximum as u64 + 1)
            .read_to_end(&mut bytes)?;
        need(
            bytes.len() <= maximum
                && bytes.len() as u64 == file.metadata()?.len()
                && Instant::now() < end,
            "WEBSITE_BUILD_INPUT_BOUND_OR_CHANGED",
        )?;
        Ok(bytes)
    })
}
pub(super) struct Measured {
    pub pin: CodeFile,
    pub elf: bool,
    pub executable: bool,
    pub mode: u32,
}
pub(super) fn code(path: &Path, end: Instant) -> Result<Measured> {
    with(path, 256 << 20, true, |file| {
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 65536];
        let mut prefix = Vec::new();
        let mut count = 0_u64;
        loop {
            need(Instant::now() < end, "WEBSITE_BUILD_CODE_DEADLINE")?;
            let n = file.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            count += n as u64;
            need(count <= 256 << 20, "WEBSITE_BUILD_CODE_BOUND")?;
            digest.update(&buffer[..n]);
            let remaining = 4_usize.saturating_sub(prefix.len());
            prefix.extend_from_slice(&buffer[..n.min(remaining)]);
        }
        let metadata = file.metadata()?;
        need(count == metadata.len(), "WEBSITE_BUILD_CODE_CHANGED")?;
        Ok(Measured {
            pin: CodeFile {
                path: text(path)?,
                sha256: JournalDigest::parse(&format!("{:x}", digest.finalize()))?,
                bytes: count,
            },
            elf: prefix == b"\x7fELF",
            executable: metadata.mode() & 0o111 != 0,
            mode: metadata.mode() & 0o7777,
        })
    })
}
pub(super) fn text(path: &Path) -> Result<PythonText> {
    Ok(PythonText::try_new(reverie_core::posix_text::decode(
        path.as_os_str().as_bytes(),
    ))
    .expect("filesystem codepoints"))
}
pub(super) fn path(text: &PythonText) -> Result<std::path::PathBuf> {
    Ok(std::ffi::OsString::from_vec(reverie_core::posix_text::encode(text.codepoints())?).into())
}
pub(super) fn combine<T>(first: Result<T>, second: Result<()>) -> Result<T> {
    match (first, second) {
        (result, Ok(())) => result,
        (Ok(_), Err(error)) => Err(error),
        (Err(first), Err(second)) => Err(format!("{first}; observation/close: {second}").into()),
    }
}
