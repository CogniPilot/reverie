//! Small command runner following CogniPilot/rumoca's cargo-xtask convention.
//! Repository policies are integration tests; this runner only invokes programs.

use std::error::Error;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
mod worker_package;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("xtask: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    match arguments.as_slice() {
        [] => help(),
        [command] if ["help", "--help", "-h"].contains(&command.as_str()) => help(),
        [command] if ["check", "verify"].contains(&command.as_str()) => verify(false)?,
        [command] if ["check-portable", "verify-portable"].contains(&command.as_str()) => {
            verify(true)?
        }
        [command] if command == "verify-worker-package" => {
            worker_package::verify(&workspace_root()?)?
        }
        _ => return Err("expected a cargo xtask verification command (or --help)".into()),
    }
    Ok(())
}

fn help() {
    println!(
        "cargo xtask check | verify\n  Check Rust formatting, strict Clippy, workspace tests and repository policies.\ncargo xtask verify-portable\n  Check platform-neutral core, contracts, HTTP, OPS CLI, route handlers and task tooling; native Linux host acceptance is separate.\ncargo xtask verify-worker-package\n  Linux: qualify the selected executable/manifest and Goal-stream broker interoperability."
    );
}

fn workspace_root() -> Result<PathBuf, Box<dyn Error>> {
    // Cargo supplies the current invocation's package directory at runtime.
    // A cached executable can have been compiled in a different checkout.
    let manifest = std::env::var_os("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .ok_or("invoke this runner with cargo xtask")?;
    if !manifest.is_absolute() {
        return Err("cargo xtask requires an absolute package directory".into());
    }
    manifest
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| "xtask is not inside the workspace crates directory".into())
}
fn verify(portable: bool) -> Result<(), Box<dyn Error>> {
    let root = workspace_root()?;
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    step(&cargo, &["fmt", "--all", "--check"], &root)?;
    let packages: &[&str] = if portable {
        &[
            "-p",
            "reverie-core",
            "-p",
            "reverie-contracts",
            "-p",
            "reverie-routes",
            "-p",
            "reverie-http",
            "-p",
            "reverie-ops-cli",
            "-p",
            "xtask",
        ]
    } else {
        &["--workspace"]
    };
    let mut clippy = vec!["clippy", "--locked"];
    clippy.extend_from_slice(packages);
    clippy.extend_from_slice(&["--all-targets", "--all-features", "--", "-D", "warnings"]);
    step(&cargo, &clippy, &root)?;
    let mut tests = vec!["test", "--locked"];
    tests.extend_from_slice(packages);
    tests.extend_from_slice(&["--all-targets", "--all-features"]);
    let mut command = Command::new(&cargo);
    command.args(&tests).current_dir(&root);
    #[cfg(unix)]
    if !portable {
        // Native fixtures own private children; keep their Unix socket paths
        // below SUN_LEN even when Nix/CI supplies a deeply nested temp root.
        command.env("TMPDIR", "/tmp");
    }
    run_command(&mut command)
}

fn step(program: &OsStr, arguments: &[&str], root: &Path) -> Result<(), Box<dyn Error>> {
    run_command(Command::new(program).args(arguments).current_dir(root))
}
fn run_command(command: &mut Command) -> Result<(), Box<dyn Error>> {
    eprintln!(
        "+ {:?} {:?}",
        command.get_program(),
        command.get_args().collect::<Vec<_>>()
    );
    let status = command.status()?;
    if !status.success() {
        return Err(format!("{:?} failed: {status}", command.get_program()).into());
    }
    Ok(())
}
