//! Immutable website factory observations only. Never starts a website,
//! executes image members or substitutes for native installation authority.
mod archive;
mod input;
use crate::output;
use clap::Parser;
use reverie_contracts::resource_actor::{
    ArtifactReference, NativeResourceClientManifest, ProgramSelection, WebsiteProvenanceBuild,
    WebsiteStartupBuildGraph,
};
use reverie_core::{PythonText, operations::JournalDigest};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Parser)]
#[command(
    about = "Build website provenance v1 facts from fixed immutable Nix inputs; no image execution or runtime authority"
)]
struct Arguments {
    #[arg(long)]
    archive: PathBuf,
    #[arg(long)]
    console: PathBuf,
    #[arg(long)]
    node: PathBuf,
    #[arg(long)]
    client_manifest: PathBuf,
    #[arg(long)]
    program_manifest: Option<PathBuf>,
    #[arg(long)]
    output: PathBuf,
}
pub(super) fn requested() -> bool {
    std::env::args_os()
        .nth(1)
        .is_some_and(|v| v == "website-image-provenance")
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
    need(
        args.console.is_absolute()
            && args.console.starts_with("/nix/store")
            && args.console.canonicalize()? == args.console
            && args.console.is_dir(),
        "WEBSITE_BUILD_CONSOLE_OUTPUT",
    )?;
    need(
        args.node.is_absolute()
            && args.node.starts_with("/nix/store")
            && !args.node.components().any(|c| c == Component::ParentDir),
        "WEBSITE_BUILD_NODE_INVOCATION",
    )?;
    let executable = args.node.canonicalize()?;
    let node_code = input::code(&executable, end)?;
    need(node_code.elf, "WEBSITE_BUILD_NODE_ELF")?;
    let entry_path = args.console.join("lib/reverie/dist/index.js");
    let entry = input::code(&entry_path, end)?;
    let client_raw = input::read(&args.client_manifest, 8192, end)?;
    let client = NativeResourceClientManifest::decode(&client_raw)?;
    let client_code = input::code(&input::path(client.executable())?, end)?;
    need(
        client_code.pin.sha256 == *client.executable_digest()
            && client_code.elf
            && client_code.executable,
        "WEBSITE_BUILD_NATIVE_CLIENT_BYTES_OR_ELF",
    )?;
    let console = input::text(&args.console)?;
    let node = ProgramSelection {
        executable: input::text(&executable)?,
        argv: vec![input::text(&args.node)?, input::text(&entry_path)?],
    };
    let mut build = WebsiteProvenanceBuild::new(
        archive::configuration(&args.archive, end)?,
        console.clone(),
        node,
        reference(&args.client_manifest, &client_raw)?,
        &[client_code.pin, entry.pin, node_code.pin],
    )?;
    if let Some(path) = args.program_manifest {
        startup(&mut build, &path, &console, &executable, end)?;
    }
    need(Instant::now() < end, "WEBSITE_BUILD_DEADLINE")?;
    fs::create_dir_all(args.output.parent().ok_or("WEBSITE_BUILD_OUTPUT_PARENT")?)?;
    Ok(output::write_new(&args.output, &build.encode())?)
}
fn startup(
    build: &mut WebsiteProvenanceBuild,
    path: &Path,
    console: &PythonText,
    node: &Path,
    end: Instant,
) -> Result<()> {
    let raw = input::read(path, 65536, end)?;
    let graph = WebsiteStartupBuildGraph::decode(&raw, console, &input::text(node)?)?;
    let resolved_node = input::path(graph.node_invocation())?.canonicalize()?;
    let resolved_python = input::path(graph.python_invocation())?.canonicalize()?;
    let python_executable = input::path(graph.python_executable())?;
    need(
        python_executable.canonicalize()? == python_executable,
        "WEBSITE_BUILD_CANONICAL_STARTUP_PYTHON",
    )?;
    graph.require_resolutions(
        &input::text(&resolved_node)?,
        &input::text(&resolved_python)?,
    )?;
    for expected in graph.code_files() {
        let measured = input::code(&input::path(&expected.path)?, end)?;
        need(
            measured.pin == *expected,
            "WEBSITE_BUILD_STARTUP_CODE_CHANGED",
        )?;
    }
    build.include_startup(graph, reference(path, &raw)?)?;
    Ok(())
}
fn reference(path: &Path, raw: &[u8]) -> Result<ArtifactReference> {
    Ok(ArtifactReference {
        path: input::text(path)?,
        sha256: JournalDigest::parse(&format!("{:x}", Sha256::digest(raw)))?,
    })
}
fn need(value: bool, reason: &'static str) -> Result<()> {
    if value { Ok(()) } else { Err(reason.into()) }
}
