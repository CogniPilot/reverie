//! xtask must build from the standard library alone. `cargo xtask verify-portable` runs
//! `cargo test -p … -p xtask` from the xtask executable; any dependency can be rebuilt there with
//! features unified across the other packages, which relinks the running executable, and Windows
//! refuses to replace a running executable.

use crate::support::workspace_root;
use std::fs;

fn check(manifest: &str) -> Result<(), String> {
    let offenders: Vec<&str> = manifest
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('['))
        .filter(|line| line.contains("dependencies") && !line.contains("dev-dependencies"))
        .collect();
    if offenders.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "xtask declares dependencies ({}); put the tool in its own crate and binary",
            offenders.join(", ")
        ))
    }
}

#[test]
fn xtask_has_no_dependencies() {
    let manifest = fs::read_to_string(workspace_root().join("crates/xtask/Cargo.toml"))
        .expect("xtask manifest");
    check(&manifest).unwrap();
}

#[test]
fn dependency_sections_are_rejected() {
    for section in [
        "[dependencies]",
        "[build-dependencies]",
        "[target.'cfg(windows)'.dependencies]",
        "[dependencies.serde]",
    ] {
        let manifest = format!("[package]\nname = \"xtask\"\n\n{section}\nserde = \"1\"\n");
        assert!(check(&manifest).is_err(), "{section}");
    }
    assert!(check("[package]\nname = \"xtask\"\n\n[dev-dependencies]\nserde = \"1\"\n").is_ok());
}

/// The workspace takes every crate under `crates/` by glob, so adding a crate never edits the
/// root manifest and two branches that each add one no longer conflict there.
fn members(manifest: &str) -> Result<(), String> {
    let mut in_workspace = false;
    for line in manifest.lines().map(str::trim) {
        if line.starts_with('[') {
            in_workspace = line == "[workspace]";
        } else if in_workspace && line.starts_with("members") {
            return if line == r#"members = ["crates/*"]"# {
                Ok(())
            } else {
                Err(format!(
                    "workspace members must be the crates/* glob, not `{line}`; a crate under crates/ is picked up automatically"
                ))
            };
        }
    }
    Err("the root manifest has no [workspace] members".into())
}

#[test]
fn workspace_members_are_the_crates_glob() {
    let manifest = fs::read_to_string(workspace_root().join("Cargo.toml")).expect("root manifest");
    members(&manifest).unwrap();
}

#[test]
fn an_explicit_member_list_is_rejected() {
    assert!(members("[workspace]\nmembers = [\"crates/*\"]\nresolver = \"3\"\n").is_ok());
    for manifest in [
        "[workspace]\nmembers = [\n    \"crates/a\",\n    \"crates/b\",\n]\n",
        "[workspace]\nmembers = [\"crates/*\", \"tools/x\"]\n",
        "[package]\nname = \"x\"\n",
    ] {
        assert!(members(manifest).is_err(), "{manifest}");
    }
}
