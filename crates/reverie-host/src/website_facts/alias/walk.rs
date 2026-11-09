use super::*;
use code::files::{Stamp, open_image_link};
use nix::{
    fcntl::readlinkat,
    sys::statvfs::{FsFlags, fstatvfs},
};
use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::PathBuf,
};

pub(super) fn alias(
    files: &mut Descriptors,
    init: &UnsignedInteger,
    path: &Path,
    end: Instant,
) -> Result<PathBuf> {
    check_end(end)?;
    let root = files.retain(
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC)
            .open(format!("/proc/{}/root", init.as_str()))?,
    );
    let mapped = code::mapped_root_uid(files, init, end)?;
    let mut pending: VecDeque<_> = path
        .components()
        .skip(1)
        .map(|value| value.as_os_str().to_owned())
        .collect();
    let mut current = PathBuf::from("/");
    let mut links = 0;
    while let Some(part) = pending.pop_front() {
        check_end(end)?;
        current.push(part);
        let info = fs::symlink_metadata(&current)?;
        need(info.uid() == 0, "IMMUTABLE_HOST_ALIAS_REQUIRED")?;
        if info.file_type().is_symlink() {
            links += 1;
            need(
                links <= 32 && current.starts_with("/nix/store"),
                "INVOCATION_LINK_BOUND",
            )?;
            let target = compare_link(files, root, &current, &info, mapped, end)?;
            let normalized = normalized_target(&current, &target)?;
            let mut replacement: VecDeque<_> = normalized
                .components()
                .skip(1)
                .map(|value| value.as_os_str().to_owned())
                .collect();
            replacement.append(&mut pending);
            pending = replacement;
            current = PathBuf::from("/");
        } else if !pending.is_empty() {
            need(info.is_dir(), "HOST_INVOCATION_PARENT_CHANGED")?;
        }
    }
    check_end(end)?;
    Ok(current)
}
fn compare_link(
    files: &mut Descriptors,
    root: usize,
    path: &Path,
    host: &fs::Metadata,
    mapped: u32,
    end: Instant,
) -> Result<PathBuf> {
    check_end(end)?;
    let expected = fs::read_link(path)?;
    let index = files.retain(open_image_link(files.get(root), path)?);
    let guest = files.get(index).metadata()?;
    need(
        guest.file_type().is_symlink()
            && guest.uid() == mapped
            && fstatvfs(files.get(index))
                .map_err(io::Error::from)?
                .flags()
                .contains(FsFlags::ST_RDONLY)
            && readlinkat(files.get(index), "").map_err(io::Error::from)? == expected.as_os_str(),
        "IMAGE_INVOCATION_ALIAS_CHANGED",
    )?;
    need(
        Stamp::of(&files.get(index).metadata()?) == Stamp::of(&guest)
            && Stamp::of(&fs::symlink_metadata(path)?) == Stamp::of(host),
        "INVOCATION_ALIAS_READ_CHANGED",
    )?;
    check_end(end)?;
    Ok(expected)
}
pub(super) fn normalized_target(link: &Path, target: &Path) -> Result<PathBuf> {
    let combined = if target.is_absolute() {
        target.to_owned()
    } else {
        link.parent().expect("absolute link").join(target)
    };
    let lexical = reverie_core::posix_path::PosixPath::try_new(&native::python_text(&combined))
        .map_err(|_| WebsiteFactsError::Refused("INVOCATION_ALIAS_ESCAPES_CODE_ROOT"))?;
    need(
        lexical.is_single_rooted(),
        "INVOCATION_ALIAS_ESCAPES_CODE_ROOT",
    )?;
    let mut parts = Vec::new();
    for part in lexical.components() {
        if part == [46, 46] {
            parts.pop();
        } else {
            parts.push(part);
        }
    }
    let mut points = vec![47];
    for (index, part) in parts.iter().enumerate() {
        if index != 0 {
            points.push(47);
        }
        points.extend_from_slice(part);
    }
    nix_path(&PythonText::try_new(points).expect("existing codepoints"))
        .map_err(|_| WebsiteFactsError::Refused("INVOCATION_ALIAS_ESCAPES_CODE_ROOT"))
}
