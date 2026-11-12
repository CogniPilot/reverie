//! Public build-input qualification only. Never launches Codex or grants a
//! native build/runtime acceptance result, owner permission or effect authority.
mod inputs;
mod report;
use crate::output;
use clap::{Parser, ValueEnum};
use inputs::Qualified;
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const MAX_DOCUMENT: usize = 2 << 20;
const MAX_LOCK: usize = 32 << 20;
const MAX_PATCHED_FILE: usize = 8 << 20;

#[derive(Clone, Copy, ValueEnum)]
enum Mode {
    Source,
    Vendor,
}
impl Mode {
    fn name(self) -> &'static str {
        match self {
            Self::Source => "source",
            Self::Vendor => "vendor",
        }
    }
}
#[derive(Parser)]
#[command(
    name = "reverie-policy-artifacts codex-observer-inputs",
    about = "Qualify pinned public source or vendor inputs without launching Codex"
)]
struct Arguments {
    #[arg(value_enum)]
    mode: Mode,
    root: PathBuf,
    provenance: PathBuf,
    git_hashes: PathBuf,
    /// Include the completed locked, offline cargo-metadata result in a vendor
    /// report. The caller must run Cargo separately; this tool executes nothing.
    #[arg(long)]
    cargo_metadata: Option<PathBuf>,
}
pub(super) fn requested() -> bool {
    std::env::args_os()
        .nth(1)
        .is_some_and(|v| v == "codex-observer-inputs")
}
pub(super) fn run() -> Result<()> {
    let args = Arguments::parse_from(
        std::iter::once(std::env::args_os().next().unwrap_or_default())
            .chain(std::env::args_os().skip(2)),
    );
    qualify(args)
}
fn qualify(args: Arguments) -> Result<()> {
    need(
        matches!(args.mode, Mode::Vendor) || args.cargo_metadata.is_none(),
        "Cargo metadata is only valid for vendor qualification",
    )?;
    let lock = args.root.join(match args.mode {
        Mode::Source => "codex-rs/Cargo.lock",
        Mode::Vendor => "Cargo.lock",
    });
    let qualified = Qualified::from_inputs(
        &read(&lock, MAX_LOCK)?,
        &read(&args.provenance, MAX_DOCUMENT)?,
        &read(&args.git_hashes, MAX_DOCUMENT)?,
    )?;
    match args.mode {
        Mode::Source => source(&args.root, &qualified)?,
        Mode::Vendor => vendor(&args.root, &qualified)?,
    }
    let metadata = args
        .cargo_metadata
        .as_deref()
        .map(|path| read(path, 16 << 20))
        .transpose()?;
    report::write(args.mode.name(), &qualified, metadata.as_deref())
}
fn source(root: &Path, qualified: &Qualified) -> Result<()> {
    for (relative, digest) in qualified.patched_files() {
        let relative = Path::new(relative);
        need(
            relative
                .components()
                .all(|v| matches!(v, Component::Normal(_)))
                && !relative.as_os_str().is_empty(),
            "Patched source must use a relative path without parent components",
        )?;
        let path = root.join(relative);
        let metadata = fs::symlink_metadata(&path)?;
        need(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "Reviewed patched source must be a regular file",
        )?;
        need(
            inputs::digest(&read(&path, MAX_PATCHED_FILE)?) == *digest,
            "Reviewed patched source mismatch",
        )?;
    }
    Ok(())
}
fn vendor(root: &Path, qualified: &Qualified) -> Result<()> {
    let raw = read(&root.join(".cargo/config.toml"), MAX_DOCUMENT)?;
    inputs::validate_vendor_configuration(&raw)?;
    let mut actual = BTreeSet::new();
    for entry in fs::read_dir(root)? {
        let name = entry?.file_name().into_string().map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "Non-UTF-8 vendor name")
        })?;
        if !matches!(name.as_str(), ".cargo" | "Cargo.lock") {
            actual.insert(name);
        }
    }
    need(
        actual == *qualified.vendor_names(),
        "Vendor crate set mismatch",
    )?;
    for name in qualified.vendor_names() {
        let path = root.join(name);
        need(
            path.is_dir() && path.join(".cargo-checksum.json").is_file(),
            "Incomplete vendored crate",
        )?;
    }
    Ok(())
}
fn read(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let raw = output::read_bounded(path, limit)?;
    need(
        raw.len() <= limit,
        "Public input document exceeds its bound",
    )?;
    Ok(raw)
}
fn need(value: bool, message: &'static str) -> Result<()> {
    if value { Ok(()) } else { Err(message.into()) }
}
