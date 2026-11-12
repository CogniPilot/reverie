//! Build-only complete host-resume graph DATA. Runtime peer authentication and
//! any worker/owner/maintenance action remain with their actual native owners.
mod tree;
use crate::{build_input as input, output};
use clap::Parser;
use input::{Result, need};
use reverie_contracts::{
    resource_actor::{ArtifactReference, WebsiteStartupBuildGraph},
    worker_resume::ResumeProgramBuild,
};
use reverie_core::{PythonText, operations::JournalDigest, posix_path::PosixPath};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Parser)]
#[command(
    about = "Build complete immutable host-worker resume-program v1 facts; executes no program and grants no authority"
)]
struct Arguments {
    #[arg(long)]
    console: PathBuf,
    #[arg(long)]
    node: PathBuf,
    #[arg(long)]
    owner_terminal_program: Option<PathBuf>,
    #[arg(long)]
    output: PathBuf,
}
pub(super) fn requested() -> bool {
    std::env::args_os()
        .nth(1)
        .is_some_and(|v| v == "worker-resume-program")
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
    let raw_invocation = input::text(&args.node)?;
    let invocation =
        PythonText::try_new(PosixPath::try_new(raw_invocation.codepoints())?.codepoints())?;
    let executable = input::path(&invocation)?.canonicalize()?;
    let before = fs::symlink_metadata(&executable)?;
    let node = input::code(&executable, end)?;
    let console = input::text(&args.console)?;
    let mut graph = ResumeProgramBuild::new(console.clone(), invocation, node.pin, node.mode)?;
    let raw = tree::with_tree(&args.console, end, |tree| {
        tree.node(&executable, &before)?;
        tree.observe(&mut graph)?;
        if let Some(path) = &args.owner_terminal_program {
            let selected = owner_program(path, &console, &executable, end)?;
            graph.owner_terminal_program(selected)?;
        }
        let raw = graph.encode()?;
        tree.assert_current()?;
        Ok(raw)
    })?;
    need(Instant::now() < end, "RESUME_PROGRAM_DEADLINE")?;
    fs::create_dir_all(args.output.parent().ok_or("RESUME_OUTPUT_PARENT")?)?;
    Ok(output::write_new(&args.output, &raw)?)
}
fn owner_program(
    path: &Path,
    console: &PythonText,
    node: &Path,
    end: Instant,
) -> Result<ArtifactReference> {
    let raw = input::read(path, 65536, end)?;
    let graph = WebsiteStartupBuildGraph::decode_protected(&raw, console, &input::text(node)?)?;
    let resolved_node = input::path(graph.node_invocation())?.canonicalize()?;
    let resolved_python = input::path(graph.python_invocation())?.canonicalize()?;
    let python_executable = input::path(graph.python_executable())?;
    need(
        python_executable.canonicalize()? == python_executable,
        "RESUME_H_CANONICAL_PYTHON",
    )?;
    graph.require_resolutions(
        &input::text(&resolved_node)?,
        &input::text(&resolved_python)?,
    )?;
    for expected in graph.code_files() {
        let measured = input::code(&input::path(&expected.path)?, end)?;
        need(measured.pin == *expected, "RESUME_H_CODE_CHANGED")?;
    }
    Ok(ArtifactReference {
        path: input::text(path)?,
        sha256: JournalDigest::parse(&format!("{:x}", Sha256::digest(&raw)))?,
    })
}
