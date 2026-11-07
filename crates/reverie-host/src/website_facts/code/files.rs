use super::*;
use nix::fcntl::{OFlag, OpenHow, ResolveFlag, openat2};
use reverie_core::PythonText;
#[derive(Eq, PartialEq)]
pub(in crate::website_facts) struct Stamp {
    device: u64,
    inode: u64,
    mode: u32,
    uid: u32,
    bytes: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}
impl Stamp {
    pub(in crate::website_facts) fn of(info: &fs::Metadata) -> Self {
        Self {
            device: info.dev(),
            inode: info.ino(),
            mode: info.mode(),
            uid: info.uid(),
            bytes: info.len(),
            mtime: (info.mtime(), info.mtime_nsec()),
            ctime: (info.ctime(), info.ctime_nsec()),
        }
    }
}
pub(in crate::website_facts) fn check_end(end: Instant) -> Result<()> {
    need(Instant::now() < end, "BACKEND_CODE_DEADLINE")
}
pub(in crate::website_facts) fn nix_path(value: &PythonText) -> Result<PathBuf> {
    let parsed = reverie_core::posix_path::PosixPath::try_new(value.codepoints())
        .map_err(|_| WebsiteFactsError::Refused("IMMUTABLE_CODE_PATH"))?;
    need(
        parsed.is_absolute()
            && parsed.codepoints() == value.codepoints()
            && !parsed.has_parent_component()
            && !value.codepoints().contains(&0)
            && value
                .codepoints()
                .starts_with(&"/nix/store/".chars().map(u32::from).collect::<Vec<_>>()),
        "IMMUTABLE_CODE_PATH",
    )?;
    Ok(native::python_path(value.codepoints())?)
}
pub(super) fn open_image(root: &File, path: &Path) -> Result<File> {
    let how = OpenHow::new()
        .flags(OFlag::O_RDONLY | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC)
        .resolve(
            ResolveFlag::RESOLVE_IN_ROOT
                | ResolveFlag::RESOLVE_NO_MAGICLINKS
                | ResolveFlag::RESOLVE_NO_SYMLINKS,
        );
    Ok(File::from(
        openat2(root, path, how).map_err(io::Error::from)?,
    ))
}
