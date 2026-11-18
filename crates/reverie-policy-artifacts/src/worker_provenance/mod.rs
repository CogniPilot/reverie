//! Fixed worker factory facts only. No engine, installed owner, launch, UID
//! mapping, executable image member or publication authority is obtained here.
mod archive;
mod layers;
#[cfg(test)]
mod tests;
use crate::{build_archive, build_input as input, output};
use clap::Parser;
use input::{Result, need};
use reverie_contracts::resource_actor::{
    CodeFile, WORKER_FACTORY_INVENTORY, WORKER_FACTORY_INVENTORY_PATH, WebsiteArchiveManifest,
    WorkerImageProvenanceBuild, worker_factory_files,
};
use reverie_core::operations::JournalDigest;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Parser)]
#[command(about = "Build worker-image provenance v2 from fixed immutable Nix inputs")]
struct Arguments {
    #[arg(long)]
    archive: PathBuf,
    #[arg(long)]
    source: PathBuf,
    #[arg(long)]
    profile: PathBuf,
    #[arg(long)]
    toolkit_manifest: PathBuf,
    #[arg(long)]
    output: PathBuf,
}
pub(super) fn requested() -> bool {
    std::env::args_os()
        .nth(1)
        .is_some_and(|v| v == "worker-image-provenance")
}
pub(super) fn run() -> Result<()> {
    let args = Arguments::parse_from(
        std::iter::once(std::env::args_os().next().unwrap_or_default())
            .chain(std::env::args_os().skip(2)),
    );
    build(args)
}
fn build(args: Arguments) -> Result<()> {
    let end = Instant::now() + Duration::from_secs(300);
    let profile = input::read(&args.profile, 4096, end)?;
    need(
        args.source.is_absolute()
            && args.source.canonicalize()? == args.source
            && args.source.is_dir(),
        "WORKER_BUILD_CANONICAL_SOURCE",
    )?;
    let sources = source_pins(&args.source, end)?;
    need(
        args.toolkit_manifest
            .ends_with("share/reverie-human-terminal/manifest.json"),
        "WORKER_BUILD_FIXED_TOOLKIT_MANIFEST",
    )?;
    let raw_toolkit = input::read(&args.toolkit_manifest, 8192, end)?;
    let toolkit_pin = pin(&args.toolkit_manifest, &raw_toolkit)?;
    let encoded = input::with(&args.archive, 16 << 30, false, |file| {
        let (metadata, selected) = build_archive::held_metadata(file, end)?;
        let build =
            WorkerImageProvenanceBuild::new(metadata, &profile, &raw_toolkit, &toolkit_pin)?;
        toolkit(&args.toolkit_manifest, &build, end)?;
        qualify_layers(file, &build, &selected, end)?;
        let archive_pin = archive::compressed_pin(file, &args.archive, end)?;
        Ok(build.encode(&archive_pin, &input::text(&args.source)?, &sources)?)
    })?;
    need(Instant::now() < end, "WORKER_BUILD_DEADLINE")?;
    fs::create_dir_all(args.output.parent().ok_or("WORKER_BUILD_OUTPUT_PARENT")?)?;
    Ok(output::write_new(&args.output, &encoded)?)
}
fn qualify_layers(
    file: &mut File,
    build: &WorkerImageProvenanceBuild,
    selected: &WebsiteArchiveManifest,
    end: Instant,
) -> Result<()> {
    archive::preflight_layers(file, end)?;
    let layers = archive::layers(file, build, end)?;
    let hashes = layers
        .iter()
        .map(|(name, layer)| {
            Ok((
                build_archive::python_name(name),
                JournalDigest::parse(&layer.digest)?,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    build.require_layer_hashes(selected, &hashes)?;
    let ordered = selected
        .layer_members()
        .iter()
        .map(|name| {
            layers
                .iter()
                .find(|(key, _)| build_archive::python_name(key) == *name)
                .map(|(_, layer)| layer)
                .ok_or_else(|| "WORKER_BUILD_LAYER_UNAVAILABLE".into())
        })
        .collect::<Result<Vec<_>>>()?;
    layers::verify_final(&ordered, build.toolkit_files())
}
fn source_pins(source: &Path, end: Instant) -> Result<Vec<CodeFile>> {
    worker_factory_files()
        .iter()
        .map(|name| {
            let path = source.join(name);
            let data = input::read(&path, 1 << 20, end)?;
            if *name == WORKER_FACTORY_INVENTORY_PATH {
                need(
                    data == WORKER_FACTORY_INVENTORY.as_bytes(),
                    "WORKER_BUILD_SOURCE_INVENTORY",
                )?;
            }
            pin(&path, &data)
        })
        .collect()
}
fn toolkit(manifest: &Path, build: &WorkerImageProvenanceBuild, end: Instant) -> Result<()> {
    let root = manifest
        .ancestors()
        .nth(3)
        .ok_or("WORKER_BUILD_TOOLKIT_ROOT")?;
    for expected in build.toolkit_files() {
        let guest = input::path(&expected.path)?;
        let file = root.join(guest.strip_prefix("/")?);
        let raw = input::read(&file, 16 << 20, end)?;
        qualify_toolkit_binary(&raw, expected, build.elf_machine())?;
    }
    Ok(())
}
fn qualify_toolkit_binary(raw: &[u8], expected: &CodeFile, machine: u16) -> Result<()> {
    let actual = format!("{:x}", Sha256::digest(raw));
    need(
        actual == expected.sha256.as_str() && raw.len() as u64 == expected.bytes,
        "WORKER_BUILD_TOOLKIT_BYTES",
    )?;
    reverie_elf_bundle::require_static_elf64(raw, machine)?;
    Ok(())
}
fn pin(path: &Path, raw: &[u8]) -> Result<CodeFile> {
    Ok(CodeFile {
        path: input::text(path)?,
        sha256: JournalDigest::parse(&format!("{:x}", Sha256::digest(raw)))?,
        bytes: raw.len() as u64,
    })
}
