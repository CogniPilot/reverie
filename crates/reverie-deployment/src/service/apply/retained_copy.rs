use super::*;
use std::process::{Child, Command, Stdio};

pub(super) fn program() -> Result<&'static str> {
    option_env!("REVERIE_DEPLOYMENT_COPY")
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_COPY_UNINSTALLED"))
}

pub(super) fn run(program: &str, source: &Path, destination: &Path, end: Instant) -> Result<()> {
    require(Instant::now() < end, "DEPLOYMENT_RETAINED_COPY_DEADLINE")?;
    let child = Command::new(program)
        .args(["--archive", "--reflink=auto", "--no-target-directory", "--"])
        .arg(source)
        .arg(destination)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    join_copy(child, end)
}

fn join_copy(mut child: Child, end: Instant) -> Result<()> {
    loop {
        if let Some(status) = child.try_wait()? {
            return require(status.success(), "DEPLOYMENT_RETAINED_COPY_UNCONFIRMED");
        }
        if Instant::now() >= end {
            let killed = child.kill().map_err(DeploymentError::from);
            let joined = child.wait().map(|_| ()).map_err(DeploymentError::from);
            return DeploymentError::finalized(
                Err(DeploymentError::new("DEPLOYMENT_RETAINED_COPY_DEADLINE")),
                DeploymentError::finalized(killed, joined),
            );
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expired_budget_refuses_before_spawning_the_copy() {
        let path = Path::new("unused");
        let error = run("/nonexistent-copy", path, path, Instant::now()).unwrap_err();
        assert_eq!(error.code(), "DEPLOYMENT_RETAINED_COPY_DEADLINE");
    }

    #[test]
    fn bounded_copy_child_fixture() {
        if std::env::var_os("NIX_REVERIE_DEPLOYMENT_COPY_SLEEP").is_some() {
            std::thread::sleep(Duration::from_secs(10));
        }
    }

    #[test]
    fn expired_copy_deadline_joins_the_original_child_without_swap() {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child
            .args([
                "--exact",
                "service::apply::retained_copy::tests::bounded_copy_child_fixture",
            ])
            .env("NIX_REVERIE_DEPLOYMENT_COPY_SLEEP", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = child.spawn().unwrap();
        let pid = child.id();
        assert_eq!(
            join_copy(child, Instant::now()).unwrap_err().code(),
            "DEPLOYMENT_RETAINED_COPY_DEADLINE"
        );
        assert!(!Path::new(&format!("/proc/{pid}")).exists());
    }
}
