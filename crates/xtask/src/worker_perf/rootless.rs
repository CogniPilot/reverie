//! Thin fixed argv orchestration. All policy, native resources, effect latches
//! and Docker ownership are in the Host ignored test, never in xtask.
use super::*;

pub(crate) fn image(root: &Path, args: &[String]) -> Result<()> {
    let [
        image,
        policy,
        manifest,
        provenance,
        proof,
        tools,
        tool_path,
        native,
        core,
        closure,
        closure_path,
        core_closure,
        core_path,
    ] = args
    else {
        return Err("rootless acceptance requires the exact declared image/artifact/closure options; see --help".into());
    };
    if [
        policy.as_str(),
        provenance,
        tools,
        native,
        closure,
        core_closure,
    ] != [
        "--policy-manifest",
        "--image-provenance",
        "--docker-tools",
        "--native-coreutils",
        "--closure",
        "--core-closure",
    ] {
        return Err("unknown rootless acceptance option; see --help".into());
    }
    let status = Command::new("cargo")
        .current_dir(root)
        .args([
            "test",
            "--locked",
            "-p",
            "reverie-host",
            "--lib",
            "--all-features",
            "--",
            "--ignored",
            "--exact",
            "task_perf::tests::image::actual_rootless_task_v1_perf",
            "--test-threads=1",
            "--nocapture",
        ])
        .env("REVERIE_PERF_FIXTURE_IMAGE", image)
        .env("REVERIE_PERF_FIXTURE_POLICY", manifest)
        .env("REVERIE_PERF_FIXTURE_PROVENANCE", proof)
        .env("REVERIE_PERF_FIXTURE_DOCKER_TOOLS", tool_path)
        .env("REVERIE_PERF_FIXTURE_COREUTILS", core)
        .env("REVERIE_PERF_FIXTURE_CLOSURE", closure_path)
        .env("REVERIE_PERF_FIXTURE_CORE_CLOSURE", core_path)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("actual rootless/perf acceptance refused: {status}; not passed/skipped").into())
    }
}
