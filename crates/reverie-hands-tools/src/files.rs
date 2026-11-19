mod content;
mod tree;

use crate::protocol::{self, Reply, Result};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

pub(crate) use content::{edit, read, write};
pub(crate) use tree::{list, search};

fn within(root: &Path, relative: &str, write: bool) -> Result<PathBuf> {
    let path = Path::new(relative);
    if relative.is_empty() || relative.contains('\0') || relative.chars().count() > 1000 {
        return Err("path must be a non-empty relative path".into());
    }
    if path.is_absolute() {
        return Err(
            format!("path {relative:?} is absolute; use a path relative to the workspace").into(),
        );
    }
    if relative.split(['/', '\\']).any(|part| part == "..") {
        return Err(
            format!("path {relative:?} contains ..; paths must stay inside the workspace").into(),
        );
    }
    let full = canonical_target(&root.join(path))?;
    let inside = full
        .strip_prefix(root)
        .map_err(|_| format!("path {relative:?} resolves outside the workspace (symlink)"))?;
    if write && (inside.as_os_str().is_empty() || inside.starts_with(".git")) {
        return Err(format!("writing {relative:?} is not allowed").into());
    }
    Ok(full)
}

fn canonical_target(path: &Path) -> Result<PathBuf> {
    let mut pending = Vec::new();
    let mut candidate = path;
    loop {
        match fs::canonicalize(candidate) {
            Ok(mut resolved) => {
                resolved.extend(pending.into_iter().rev());
                return Ok(resolved);
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                if fs::symlink_metadata(candidate).is_ok_and(|meta| meta.file_type().is_symlink()) {
                    return Err("path contains an unresolved symlink".into());
                }
                pending.push(candidate.file_name().ok_or("workspace path disappeared")?);
                candidate = candidate.parent().ok_or("workspace path disappeared")?;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn display(root: &Path, path: &Path) -> String {
    if root == path {
        ".".into()
    } else {
        path.strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned()
    }
}

fn shown(text: String, limit: usize, truncated: bool) -> Reply {
    let (text, cut) = protocol::cap_text(text, limit);
    Reply::text(text, truncated || cut)
}

fn lines(text: &str) -> impl Iterator<Item = &str> {
    // Split like the previous Unicode text reader, including CRLF and Unicode separators.
    let mut tail = text;
    std::iter::from_fn(move || {
        if tail.is_empty() {
            return None;
        }
        let Some((offset, delimiter)) = tail.char_indices().find(|(_, ch)| {
            matches!(
                ch,
                '\n' | '\r' | '\x0b' | '\x0c' | '\x1c'
                    ..='\x1e' | '\u{85}' | '\u{2028}' | '\u{2029}'
            )
        }) else {
            return Some(std::mem::take(&mut tail));
        };
        let line = &tail[..offset];
        tail = &tail[offset + delimiter.len_utf8()..];
        if delimiter == '\r' {
            tail = tail.strip_prefix('\n').unwrap_or(tail);
        }
        Some(line)
    })
}
