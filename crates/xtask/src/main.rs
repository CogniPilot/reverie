//! Small command runner following CogniPilot/rumoca's cargo-xtask convention.
//! Repository policies are integration tests; this runner only invokes programs.

use std::error::Error;
use std::ffi::OsStr;
use std::path::Path;
use std::process::{Command, ExitCode};

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
        [command] if ["check", "verify"].contains(&command.as_str()) => verify()?,
        _ => return Err("expected `cargo xtask check` or `cargo xtask verify` (or --help)".into()),
    }
    Ok(())
}

fn help() {
    println!(
        "cargo xtask check | verify\n  Check Rust formatting, strict Clippy, workspace tests and repository policies."
    );
}

fn verify() -> Result<(), Box<dyn Error>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .ok_or("xtask is not inside the workspace crates directory")?;
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    step(&cargo, &["fmt", "--all", "--check"], root)?;
    step(
        &cargo,
        &[
            "clippy",
            "--locked",
            "--workspace",
            "--all-targets",
            "--all-features",
            "--",
            "-D",
            "warnings",
        ],
        root,
    )?;
    step(
        &cargo,
        &[
            "test",
            "--locked",
            "--workspace",
            "--all-targets",
            "--all-features",
        ],
        root,
    )
}

fn step(program: &OsStr, arguments: &[&str], root: &Path) -> Result<(), Box<dyn Error>> {
    eprintln!("+ cargo {}", arguments.join(" "));
    let status = Command::new(program)
        .args(arguments)
        .current_dir(root)
        .status()?;
    if !status.success() {
        return Err(format!("cargo {} failed: {status}", arguments.join(" ")).into());
    }
    Ok(())
}
