//! Explicit test tooling. The fixed privileged operations remain in the Rust helper.
use crate::run_command;
use std::{error::Error, path::Path, process::Command};

type Invocation<'a> = (&'static str, Vec<&'a str>);
fn invocation(arguments: &[String]) -> Result<Invocation<'_>, Box<dyn Error>> {
    match arguments {
        [mode] if mode == "--ci" => {
            Ok(("apps/web/scripts/docker-memory-high-ci.mts", vec!["--ci"]))
        }
        [
            baseline_flag,
            baseline,
            writer_flag,
            writer,
            evidence_flag,
            evidence,
        ] if baseline_flag == "--baseline-image"
            && writer_flag == "--writer-image"
            && evidence_flag == "--evidence" =>
        {
            Ok((
                "apps/web/test/fixtures/docker-memory-high-canary.ts",
                vec![baseline.as_str(), writer.as_str(), evidence.as_str()],
            ))
        }
        _ => Err(
            "expected --ci or --baseline-image ID --writer-image ID --evidence NEW_DIRECTORY"
                .into(),
        ),
    }
}
pub(super) fn verify(root: &Path, arguments: &[String]) -> Result<(), Box<dyn Error>> {
    if !cfg!(target_os = "linux") {
        return Err("memory.high native acceptance requires Linux; no check ran".into());
    }
    let (script, args) = invocation(arguments)?;
    run_command(
        Command::new("node")
            .arg("--experimental-strip-types")
            .arg(root.join(script))
            .args(args)
            .current_dir(root),
    )
}
#[cfg(test)]
mod tests {
    use super::invocation;
    #[test]
    fn explicit_modes_preserve_values_as_arguments_and_reject_extra_options() {
        let args = [
            "--baseline-image",
            "baseline",
            "--writer-image",
            "writer",
            "--evidence",
            "/owned/new evidence",
        ]
        .map(str::to_owned);
        let (_, selected) = invocation(&args).expect("fixed explicit mode");
        assert_eq!(selected, ["baseline", "writer", "/owned/new evidence"]);
        assert!(invocation(&["--ci".into(), "--anything".into()]).is_err());
        assert!(invocation(&[]).is_err());
    }
}
