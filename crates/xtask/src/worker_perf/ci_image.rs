//! Disposable CI orchestration: explicit programs/arguments, no shell evaluation.
//! The fresh private directory and initially absent tag belong to this one run.
use super::*;
use std::{fs, os::unix::fs::DirBuilderExt, path::PathBuf};
const DAEMON: &str = "unix:///var/run/docker.sock";

pub(super) fn verify(root: &Path) -> Result<()> {
    // This rejects ordinary/local invocation before host or Docker effects.
    ci::prepare()?;
    default_daemon()?;
    let temporary = std::env::var_os("RUNNER_TEMP").ok_or("RUNNER_TEMP is required")?;
    let directory =
        PathBuf::from(temporary).join(format!("reverie-worker-perf-{}", std::process::id()));
    fs::DirBuilder::new().mode(0o700).create(&directory)?;
    let mut owner = Resources {
        directory,
        tag: None,
    };
    let mut failures = Vec::new();
    if let Err(error) = owner.run(root) {
        failures.push(error.to_string());
    }
    owner.cleanup(&mut failures);
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; ").into())
    }
}
fn default_daemon() -> Result<()> {
    if std::env::var_os("DOCKER_HOST").is_some_and(|host| host != DAEMON)
        || std::env::var_os("DOCKER_CONTEXT").is_some_and(|context| context != "default")
        || output(Command::new("docker").args(["context", "show"]))?.trim() != "default"
    {
        return Err("perf CI requires the disposable runner's default system Docker daemon".into());
    }
    Ok(())
}
struct Resources {
    directory: PathBuf,
    tag: Option<String>,
}
impl Resources {
    fn run(&mut self, root: &Path) -> Result<()> {
        let archive = self.directory.join("worker-image");
        status(
            Command::new("nix")
                .current_dir(root)
                .args(["build", ".#workerImage", "--out-link"])
                .arg(&archive),
        )?;
        let policy = output(Command::new("nix").current_dir(root).args([
            "build",
            ".#workerTaskPerfPolicy",
            "--no-link",
            "--print-out-paths",
        ]))?;
        let manifest = store_output(&policy)?.join("share/reverie/worker-perf-profile.json");
        let tag = format!("reverie-perf-acceptance:ci-{}", std::process::id());
        if !tag_images(&tag)?.trim().is_empty() {
            return Err("temporary perf image tag already exists; preserved it".into());
        }
        // Retain cleanup ownership BEFORE import: even a failed copy can have
        // published the selected destination. Never import the archive's tags.
        self.tag = Some(tag.clone());
        let source = format!("docker-archive:{}", fs::canonicalize(&archive)?.display());
        let destination = format!("docker-daemon:{tag}");
        status(
            Command::new("nix")
                .current_dir(root)
                .args([
                    "run",
                    "--no-write-lock-file",
                    ".#workerPerfImageTransport",
                    "--",
                    // The only source is our immutable Nix-built archive,
                    // not a remote registry or a host policy-file dependency.
                    "--insecure-policy",
                    "copy",
                    "--dest-daemon-host",
                    DAEMON,
                ])
                .args([&source, &destination]),
        )?;
        let image = output(docker().args(["image", "inspect", "--format", "{{.Id}}", &tag]))?;
        temporary::checked_image(image.trim())?;
        super::image(root, image.trim(), &manifest)
    }
    fn cleanup(self, failures: &mut Vec<String>) {
        if let Some(tag) = self.tag {
            collect(cleanup_tag(&tag), "image", failures);
        }
        let archive = self.directory.join("worker-image");
        match fs::symlink_metadata(&archive) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => {
                if let Err(error) = temporary::ArchiveLink::capture(&archive)
                    .and_then(temporary::ArchiveLink::remove)
                {
                    failures.push(format!("temporary perf archive cleanup: {error}"));
                }
            }
        }
        if let Err(error) = fs::remove_dir(&self.directory) {
            failures.push(format!("temporary perf directory cleanup: {error}"));
        }
    }
}
fn store_output(raw: &str) -> Result<PathBuf> {
    let mut lines = raw.lines();
    let path = PathBuf::from(lines.next().ok_or("missing Nix policy output")?);
    if lines.next().is_some() || !path.starts_with("/nix/store") || !path.is_dir() {
        return Err("expected exactly one immutable Nix policy directory".into());
    }
    Ok(path)
}
fn docker() -> Command {
    let mut command = Command::new("docker");
    command.args(["--host", DAEMON]);
    command
}
fn tag_images(tag: &str) -> Result<String> {
    output(docker().args([
        "image",
        "ls",
        "--quiet",
        "--filter",
        &format!("reference={tag}"),
    ]))
}
fn cleanup_tag(tag: &str) -> Result<()> {
    if tag_images(tag)?.trim().is_empty() {
        return Ok(());
    }
    // Remove only our unique tag. Other tags or containers sharing the same
    // image remain untouched; no force/prune.
    status(docker().args(["image", "rm", tag]))
}
fn collect(result: Result<()>, resource: &str, failures: &mut Vec<String>) {
    if let Err(error) = result {
        failures.push(format!("temporary perf {resource} cleanup: {error}"));
    }
}
fn status(command: &mut Command) -> Result<()> {
    let result = command.status()?;
    if result.success() {
        Ok(())
    } else {
        Err(format!("{command:?} failed: {result}").into())
    }
}
fn output(command: &mut Command) -> Result<String> {
    let result = command.output()?;
    if !result.status.success() {
        return Err(format!(
            "{command:?} failed: {}",
            String::from_utf8_lossy(&result.stderr)
        )
        .into());
    }
    Ok(String::from_utf8(result.stdout)?)
}
