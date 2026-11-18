use super::{lines, within};
use crate::protocol::{Reply, Result, bounded_integer, prefix};
use nix::libc;
use serde::Deserialize;
use std::fmt::Write as _;
use std::{
    fs::{self, Metadata, OpenOptions, Permissions},
    io::{ErrorKind, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
};

const FILE_MAX: u64 = 2_000_000;
const READ_LINES: usize = 2000;
const LINE_MAX: usize = 2000;
const EDIT_MAX: usize = 10_000;
const WRITE_MAX: usize = 20_000;

pub(super) fn read_bytes(path: &Path, relative: &str) -> Result<(Vec<u8>, Metadata)> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|error| {
            if error.kind() == ErrorKind::NotFound {
                format!("{relative}: no such file")
            } else {
                format!("{relative}: {error}")
            }
        })?;
    let info = file.metadata()?;
    if info.is_dir() {
        return Err(format!("{relative}: is a directory").into());
    }
    if !info.is_file() {
        return Err(format!("{relative}: is not a regular file").into());
    }
    if info.len() > FILE_MAX {
        return Err(format!(
            "{relative}: {} bytes is over the {FILE_MAX}-byte file limit",
            info.len()
        )
        .into());
    }
    let mut bytes = Vec::new();
    file.take(FILE_MAX + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > FILE_MAX {
        return Err(format!("{relative}: file grew beyond the {FILE_MAX}-byte limit").into());
    }
    Ok((bytes, info))
}

pub(super) fn binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(8192)].contains(&0)
}

fn decode<'a>(bytes: &'a [u8], relative: &str) -> Result<&'a str> {
    if binary(bytes) {
        return Err(format!("{relative}: binary file").into());
    }
    std::str::from_utf8(bytes).map_err(|error| {
        format!(
            "{relative}: not UTF-8 text (at byte {})",
            error.valid_up_to()
        )
        .into()
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReadArgs {
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
}

pub(crate) fn read(root: &Path, args: ReadArgs, output: usize) -> Result<Reply> {
    let (bytes, _) = read_bytes(&within(root, &args.path, false)?, &args.path)?;
    let text = decode(&bytes, &args.path)?;
    let count = lines(text).count();
    let offset = bounded_integer(args.offset, "offset", 1, count.max(1))?;
    let limit = bounded_integer(args.limit, "limit", READ_LINES, READ_LINES)?;
    Ok(render_lines(text, count, offset, limit, output))
}

fn render_lines(text: &str, count: usize, offset: usize, limit: usize, output: usize) -> Reply {
    if count == 0 {
        return Reply::text("[empty file]".into(), false);
    }
    let mut body = String::new();
    let mut used = 0;
    let mut last = offset - 1;
    let mut cut = false;
    for (index, line) in lines(text).enumerate().skip(offset - 1).take(limit) {
        let number = index + 1;
        let length = line.chars().count();
        let line = if length > LINE_MAX {
            cut = true;
            format!("{} [line cut: {length} chars]", prefix(line, LINE_MAX))
        } else {
            line.into()
        };
        let row = format!("{number:6}\t{line}");
        used += row.chars().count() + 1;
        if used > output - 200 {
            break;
        }
        if !body.is_empty() {
            body.push('\n');
        }
        body.push_str(&row);
        last = number;
    }
    if last < count {
        cut = true;
        let _ = write!(
            body,
            "\n[showing lines {offset}-{last} of {count}; continue with offset={}]",
            last + 1
        );
    }
    Reply::text(body, cut)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EditArgs {
    path: String,
    old: String,
    new: String,
    count: Option<usize>,
}

pub(crate) fn edit(root: &Path, args: EditArgs) -> Result<Reply> {
    if args.old.is_empty() {
        return Err("old must not be empty; use write_file to create a file".into());
    }
    if args.old.chars().count() > EDIT_MAX || args.new.chars().count() > EDIT_MAX {
        return Err(format!("old and new are limited to {EDIT_MAX} chars each").into());
    }
    if args.old == args.new {
        return Err("old and new are the same".into());
    }
    let count = bounded_integer(args.count, "count", 1, 1000)?;
    let path = within(root, &args.path, true)?;
    let (bytes, metadata) = read_bytes(&path, &args.path)?;
    let text = decode(&bytes, &args.path)?;
    let found = text.matches(&args.old).count();
    if found != count {
        return Err(format!("{}: old text found {found} time(s), expected {count}; include more surrounding lines to make it unique, or set count", args.path).into());
    }
    let updated = text.replace(&args.old, &args.new);
    let before = file_revision(&metadata);
    atomic_write(&path, &updated, metadata.mode(), || {
        if fs::symlink_metadata(&path).map(|info| file_revision(&info))? != before {
            return Err(format!("{}: changed while being edited; read it again", args.path).into());
        }
        Ok(())
    })?;
    let line_count = |value: &str| value.bytes().filter(|byte| *byte == b'\n').count() as i64;
    let delta = line_count(&updated) - line_count(text);
    Ok(Reply::text(
        format!(
            "edited {}: {count} replacement(s), {delta:+} line(s), now {} bytes",
            args.path,
            updated.len()
        ),
        false,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WriteArgs {
    path: String,
    content: String,
}

pub(crate) fn write(root: &Path, args: WriteArgs) -> Result<Reply> {
    let chars = args.content.chars().count();
    if chars > WRITE_MAX {
        return Err(format!("content is {chars} chars, over the {WRITE_MAX}-char limit; write a smaller file and extend it with edit_file").into());
    }
    let path = within(root, &args.path, true)?;
    let current = match fs::symlink_metadata(&path) {
        Ok(info) if info.is_file() => Some(info),
        Ok(_) => return Err(format!("{}: is not a regular file", args.path).into()),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    fs::create_dir_all(path.parent().ok_or("workspace file has no parent")?)?;
    let mode = current.as_ref().map_or(0o644, MetadataExt::mode);
    atomic_write(&path, &args.content, mode, || Ok(()))?;
    let action = if current.is_some() {
        "replaced"
    } else {
        "created"
    };
    Ok(Reply::text(
        format!("{action} {} ({} bytes)", args.path, args.content.len()),
        false,
    ))
}

fn file_revision(meta: &Metadata) -> (u64, u64, u64, i64, i64) {
    (
        meta.dev(),
        meta.ino(),
        meta.len(),
        meta.mtime(),
        meta.mtime_nsec(),
    )
}

fn atomic_write(
    path: &Path,
    content: &str,
    mode: u32,
    check: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let mut nonce = [0; 12];
    getrandom::getrandom(&mut nonce).map_err(|error| error.to_string())?;
    let suffix: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    let temp = path.with_file_name(format!(".tool-{suffix}.tmp"));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temp)?;
    let result = (|| {
        file.write_all(content.as_bytes())?;
        file.set_permissions(Permissions::from_mode(mode & 0o7777))?;
        check()?;
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
