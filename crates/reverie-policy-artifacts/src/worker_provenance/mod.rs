//! Fixed worker factory facts only. No engine, installed owner, launch, UID
//! mapping, executable image member or publication authority is obtained here.
mod archive;
mod layers;
use crate::{build_archive, build_input as input, output};
use clap::Parser;
use input::{Result, need};
use reverie_contracts::resource_actor::{
    CodeFile, WORKER_IMAGE_V1_FACTORY_FILES, WorkerImageProvenanceBuild,
};
use reverie_core::operations::JournalDigest;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Parser)]
#[command(
    about = "Build existing worker-image provenance v1 facts from fixed immutable Nix inputs; no runtime authority"
)]
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
    let mut sources = Vec::new();
    for name in WORKER_IMAGE_V1_FACTORY_FILES {
        let path = args.source.join(name);
        sources.push(pin(&path, &input::read(&path, 1 << 20, end)?)?);
    }
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
        archive::preflight_layers(file, end)?;
        let layers = archive::layers(file, &build, end)?;
        let hashes = layers
            .iter()
            .map(|(name, layer)| {
                Ok((
                    build_archive::python_name(name),
                    JournalDigest::parse(&layer.digest)?,
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        build.require_layer_hashes(&selected, &hashes)?;
        let mut ordered = Vec::new();
        for name in selected.layer_members() {
            let layer = layers
                .iter()
                .find(|(key, _)| build_archive::python_name(key) == *name)
                .ok_or("WORKER_BUILD_LAYER_UNAVAILABLE")?;
            ordered.push(layer.1);
        }
        layers::verify_final(&ordered, build.toolkit_files())?;
        let archive_pin = archive::compressed_pin(file, &args.archive, end)?;
        Ok(build.encode(&archive_pin, &input::text(&args.source)?, &sources)?)
    })?;
    need(Instant::now() < end, "WORKER_BUILD_DEADLINE")?;
    fs::create_dir_all(args.output.parent().ok_or("WORKER_BUILD_OUTPUT_PARENT")?)?;
    Ok(output::write_new(&args.output, &encoded)?)
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
        let actual = pin(&file, &raw)?;
        need(
            actual.sha256 == expected.sha256 && actual.bytes == expected.bytes,
            "WORKER_BUILD_TOOLKIT_BYTES",
        )?;
        reverie_elf_bundle::require_static_elf64(&raw, build.elf_machine())?;
    }
    Ok(())
}
fn pin(path: &Path, raw: &[u8]) -> Result<CodeFile> {
    Ok(CodeFile {
        path: input::text(path)?,
        sha256: JournalDigest::parse(&format!("{:x}", Sha256::digest(raw)))?,
        bytes: raw.len() as u64,
    })
}
