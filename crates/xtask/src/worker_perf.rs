//! Real acceptance through the generated policy and Nix worker image. This is
//! test tooling, never an installed owner-policy or laptop migration shortcut.
use std::{error::Error, path::Path, process::Command};
mod ci;
type Result<T> = std::result::Result<T, Box<dyn Error>>;
pub(super) fn prepare_ci() -> Result<()> {
    ci::prepare()
}
pub(super) fn image(root: &Path, image: &str, manifest: &Path) -> Result<()> {
    if !cfg!(target_os = "linux") {
        return Err("container perf acceptance requires Linux".into());
    }
    // Reuse the existing Nix-produced contract owner, rather than change the
    // workspace lock/dependency graph just for this thin task runner.
    let verified = Command::new("nix")
        .current_dir(root)
        .args([
            "run",
            "--no-write-lock-file",
            ".#policyArtifacts",
            "--",
            "--verify-manifest",
        ])
        .arg(manifest)
        .output()?;
    if !verified.status.success() {
        return Err(format!(
            "fixed perf artifact verification failed: {}",
            String::from_utf8_lossy(&verified.stderr)
        )
        .into());
    }
    let profile = String::from_utf8(verified.stdout)?;
    drive(root, &["--image", image, "--profile", &profile])
}
pub(super) fn deployment(root: &Path, deployment: &str) -> Result<()> {
    drive(root, &["--deployment", deployment])
}
fn drive(root: &Path, args: &[&str]) -> Result<()> {
    let status = Command::new("node")
        .arg(root.join(".github/ci/worker-perf.mjs"))
        .args(args)
        .status()?;
    if !status.success() {
        return Err(format!("real container perf acceptance failed: {status}").into());
    }
    Ok(())
}
