use super::*;
use reverie_core::{chat_images::CACHE_NAME, decimal::UnsignedInteger};
use std::{fs, os::unix::fs::MetadataExt, time::Duration};
fn birth(pid: &UnsignedInteger) -> Result<String> {
    crate::reservation_kernel::chat_image_process_start(
        pid,
        Instant::now() + Duration::from_secs(20),
    )
    .map_err(ImageObserveError::Kernel)
}
pub(super) fn observe(
    pid: &UnsignedInteger,
    temporary: &Path,
    cache: bool,
) -> Result<(String, [u64; 2])> {
    let before = birth(pid)?;
    let inside = PathBuf::from(format!("/proc/{}/root/tmp", pid.as_str()));
    let guest = fs::metadata(&inside).map_err(ImageObserveError::Io)?;
    let host = fs::metadata(temporary).map_err(ImageObserveError::Io)?;
    let identity = [host.dev(), host.ino()];
    need([guest.dev(), guest.ino()] == identity, "scratch_unverified")?;
    if cache {
        let guest = fs::symlink_metadata(inside.join(CACHE_NAME)).map_err(ImageObserveError::Io)?;
        let host =
            fs::symlink_metadata(temporary.join(CACHE_NAME)).map_err(ImageObserveError::Io)?;
        need(
            guest.is_dir() && [guest.dev(), guest.ino()] == [host.dev(), host.ino()],
            "scratch_unverified",
        )?;
    }
    need(birth(pid)? == before, "binding_changed")?;
    Ok((before, identity))
}
