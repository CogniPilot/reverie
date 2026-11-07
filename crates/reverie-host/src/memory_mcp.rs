//! Fixed Node/raw-TypeScript MCP bootstrap. Artifact checks establish immutable
//! installation DATA, never process attestation or permission. Each installed
//! memory use still needs the canonical fixed-session Office/API boundary.
use crate::{
    memory_context::{ContextError, InstalledContext},
    native,
};
use reverie_core::memory_context::McpOptions;
use std::{
    fs::{self, OpenOptions},
    io::{self, Read},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug)]
pub enum McpLaunchError {
    Unavailable,
    Io(io::Error),
    Native(crate::ObservationError),
    Context(ContextError),
    Codec(reverie_contracts::memory_context::ContextCodecError),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl std::fmt::Display for McpLaunchError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str("installed MCP runtime unavailable; no alternative executable was selected")
    }
}
impl std::error::Error for McpLaunchError {}
type Result<T> = std::result::Result<T, McpLaunchError>;
fn finalized<T>(result: Result<T>, closed: Result<()>) -> Result<T> {
    match (result, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(McpLaunchError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
fn fixed(value: Option<&str>, elf: bool) -> Result<PathBuf> {
    let path = Path::new(value.ok_or(McpLaunchError::Unavailable)?);
    if !path.is_absolute()
        || !(if crate::memory_artifacts::guest() {
            crate::memory_artifacts::guest_path(path)
        } else {
            path.starts_with("/nix/store")
        })
        || fs::canonicalize(path).ok().as_deref() != Some(path)
    {
        return Err(McpLaunchError::Unavailable);
    }
    for parent in path.ancestors().skip(1) {
        let metadata = fs::symlink_metadata(parent).map_err(McpLaunchError::Io)?;
        if !metadata.is_dir()
            || metadata.uid() != 0
            || metadata.mode() & 0o022 != 0
                && (crate::memory_artifacts::guest() || metadata.mode() & 0o1000 == 0)
        {
            return Err(McpLaunchError::Unavailable);
        }
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(McpLaunchError::Io)?;
    let result = (|| {
        let before = file.metadata().map_err(McpLaunchError::Io)?;
        if !before.is_file()
            || before.uid() != 0
            || before.mode() & 0o222 != 0
            || elf && before.mode() & 0o111 == 0
        {
            return Err(McpLaunchError::Unavailable);
        }
        if elf {
            let mut magic = [0; 4];
            file.read_exact(&mut magic).map_err(McpLaunchError::Io)?;
            if magic != *b"\x7fELF" {
                return Err(McpLaunchError::Unavailable);
            }
        }
        let after = file.metadata().map_err(McpLaunchError::Io)?;
        let named = fs::symlink_metadata(path).map_err(McpLaunchError::Io)?;
        if native::Stamp::of(&before) != native::Stamp::of(&after)
            || native::Stamp::of(&before) != native::Stamp::of(&named)
        {
            return Err(McpLaunchError::Unavailable);
        }
        Ok(path.to_owned())
    })();
    finalized(result, native::close(file).map_err(McpLaunchError::Native))
}
fn chunks(text: &str) -> Vec<&str> {
    let mut remaining = text;
    let mut result = Vec::new();
    while !remaining.is_empty() {
        let mut end = remaining.len().min(32 * 1024);
        while !remaining.is_char_boundary(end) {
            end -= 1;
        }
        result.push(&remaining[..end]);
        remaining = &remaining[end..];
    }
    result
}
fn prepare(options: &McpOptions, context: Option<&InstalledContext>) -> Result<Command> {
    let node = fixed(option_env!("REVERIE_FIXED_MCP_NODE"), true)?;
    let entry = fixed(option_env!("REVERIE_FIXED_MCP_ENTRY"), false)?;
    let memory = fixed(option_env!("REVERIE_FIXED_MCP_MEMORY"), true)?;
    if context.is_some()
        && options
            .url
            .as_deref()
            .is_some_and(|url| url != reverie_core::worker_child::OFFICE_API_URL)
    {
        return Err(McpLaunchError::Unavailable);
    }
    let bytes = reverie_contracts::mcp_bootstrap::encode(
        memory.to_str().ok_or(McpLaunchError::Unavailable)?,
        options,
        context.map(|context| (context.data(), context.fingerprint())),
    )
    .map_err(McpLaunchError::Codec)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| McpLaunchError::Unavailable)?;
    let parts = chunks(text);
    let mut command = Command::new(node);
    if crate::memory_artifacts::guest() {
        command.arg("--no-global-search-paths");
    }
    command.arg(entry).arg(parts.len().to_string()).args(parts);
    // Avoid inherited loader/Node autoload hooks. This is not attestation of a
    // separately launched process, and no executable origin grants access.
    for (key, _) in std::env::vars_os() {
        if crate::memory_artifacts::code_loading_environment(&key) {
            command.env_remove(key);
        }
    }
    Ok(command)
}
/// Replaces this process only after every local observation was checked closed.
/// No child, fallback program, shell prefix or arbitrary command API is exposed.
pub fn exec_installed(options: &McpOptions) -> Result<()> {
    let mut context = InstalledContext::capture().map_err(McpLaunchError::Context)?;
    let command = prepare(options, context.as_ref());
    let closed = context.as_mut().map_or(Ok(()), |context| {
        context.close().map_err(McpLaunchError::Context)
    });
    let mut command = finalized(command, closed)?;
    Err(McpLaunchError::Io(command.exec()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bootstrap_chunks_never_split_utf8_and_reassemble_exactly() {
        let text = "α😀".repeat(40_000);
        let parts = chunks(&text);
        assert!(parts.len() > 1);
        assert!(parts.iter().all(|part| part.len() <= 32 * 1024));
        assert_eq!(parts.concat(), text);
    }
    #[test]
    fn missing_relative_or_nonstore_origins_never_search_path() {
        for path in [
            None,
            Some("node"),
            Some("/bin/node"),
            Some("/nix/store/../node"),
        ] {
            assert!(fixed(path, true).is_err());
        }
    }
}
