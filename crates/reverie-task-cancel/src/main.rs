//! `cargo task-cancel-scope`: the task-cancel acceptance controller, the native successor of
//! `scripts/acceptance/task-cancel-scope.py`. It is its own binary so xtask stays
//! dependency-free, and the private pins name this executable's sha256.
use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
mod validate;

const USAGE: &str = "cargo task-cancel-scope --check-source --lease-root DIR --pins FILE --pins-sha256 HEX\n  Validate the task-cancel controller's private pins, tool and component closure, fixture sources\n  and CPU set against this checkout and this executable; starts nothing.";

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if let [flag] = arguments.as_slice()
        && ["help", "--help", "-h"].contains(&flag.as_str())
    {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    match run(&arguments) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("task-cancel-scope: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    let [mode, rest @ ..] = arguments else {
        return Err(USAGE.into());
    };
    if mode != "--check-source" {
        return Err(USAGE.into());
    }
    let value = |flag: &str| -> Result<String, Box<dyn Error>> {
        let at = rest
            .iter()
            .position(|item| item == flag)
            .ok_or(format!("{flag} required"))?;
        rest.get(at + 1)
            .cloned()
            .ok_or_else(|| format!("{flag} needs a value").into())
    };
    let inputs = validate::Inputs {
        pins: value("--pins")?.into(),
        pins_sha256: value("--pins-sha256")?,
        lease_root: value("--lease-root")?.into(),
        source: workspace_root()?,
        executable: "/proc/self/exe".into(),
        closure: validate::Closure::nix(),
        source_only: true,
    };
    let validated = validate::validate(&inputs)?;
    println!(
        "{{\"state\":\"SOURCE_METADATA_PASS_NATIVE_NOT_RUN\",\"cpus\":{},\"pendingOperation\":{}}}",
        validated.cpus.len(),
        validated
            .pins
            .get("operationId")
            .is_none_or(serde_json::Value::is_null)
    );
    Ok(())
}

/// The checkout holding the fixture and lease sources, from the package directory cargo
/// supplies at runtime (a cached executable can have been compiled in another checkout).
fn workspace_root() -> Result<PathBuf, Box<dyn Error>> {
    let manifest = std::env::var_os("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .ok_or("invoke this controller with cargo task-cancel-scope")?;
    if !manifest.is_absolute() {
        return Err("cargo task-cancel-scope requires an absolute package directory".into());
    }
    manifest
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| "the controller is not inside the workspace crates directory".into())
}
