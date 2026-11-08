//! The root manifest names its workspace members by one glob, `crates/*`, so adding or removing a
//! crate never edits the list and parallel PRs never conflict on it. Every directory under crates/
//! must then be a crate: the glob makes any other directory there a workspace error.

use crate::support::workspace_root;
use std::fs;

/// The glob the root manifest's `[workspace] members` must be, alone.
const MEMBERS: &str = r#"["crates/*"]"#;

/// The value of `members` in the `[workspace]` table, with whitespace and comments dropped.
fn members(manifest: &str) -> Option<String> {
    let mut in_workspace = false;
    let mut value: Option<String> = None;
    for line in manifest.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if let Some(collected) = value.as_mut() {
            collected.push_str(line);
            if line.contains(']') {
                return value;
            }
        } else if line.starts_with('[') && !line.starts_with("[[") && line.ends_with(']') {
            in_workspace = line == "[workspace]";
        } else if in_workspace && let Some(rest) = line.strip_prefix("members") {
            let rest = rest.trim_start().strip_prefix('=')?.trim();
            if rest.contains(']') {
                return Some(rest.to_owned());
            }
            value = Some(rest.to_owned());
        }
    }
    None
}

fn check(manifest: &str) -> Result<(), String> {
    let found: Option<String> =
        members(manifest).map(|m| m.split_whitespace().collect::<String>().replace(",]", "]"));
    match found {
        Some(found) if found == MEMBERS => Ok(()),
        Some(found) => Err(format!(
            "[workspace] members is {found}; keep it {MEMBERS} so new crates need no edit there"
        )),
        None => Err("the root manifest has no [workspace] members".into()),
    }
}

#[test]
fn workspace_members_are_one_glob_over_crates() {
    let root = workspace_root();
    let manifest = fs::read_to_string(root.join("Cargo.toml")).expect("root manifest");
    check(&manifest).unwrap();
    let mut strays = Vec::new();
    for entry in fs::read_dir(root.join("crates")).expect("crates directory") {
        let path = entry.expect("crates entry").path();
        if path.is_dir() && !path.join("Cargo.toml").is_file() {
            strays.push(path.display().to_string());
        }
    }
    assert!(
        strays.is_empty(),
        "directories under crates/ without a Cargo.toml break the members glob: {strays:?}"
    );
}

#[test]
fn listed_members_are_rejected_and_the_glob_is_accepted() {
    let workspace = |members: &str| format!("[workspace]\nmembers = {members}\nresolver = \"3\"\n");
    assert!(check(&workspace(r#"["crates/*"]"#)).is_ok());
    assert!(check(&workspace("[ \"crates/*\" ]  # one glob")).is_ok());
    assert!(check(&workspace("[\n    \"crates/*\",\n]")).is_ok());
    for listed in [
        r#"["crates/a", "crates/b"]"#,
        "[\n    \"crates/a\",\n    \"crates/b\",\n]",
        r#"["crates/*", "tools/x"]"#,
    ] {
        assert!(check(&workspace(listed)).is_err(), "{listed}");
    }
    assert!(check("[package]\nname = \"x\"\n").is_err());
    // `members` under another table is not the workspace's.
    assert!(check("[workspace]\nresolver = \"3\"\n\n[other]\nmembers = [\"crates/*\"]\n").is_err());
}
