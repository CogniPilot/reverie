//! Prevent adding Python files/interpreters while existing implementations migrate.
//! Check the worktree and index plus nonignored untracked files, so local verify
//! and PR CI apply the same rule before or after a commit.

use crate::support::{TestDir, fixture_commit, git, workspace_root};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path};

fn git_bytes(root: &Path, arguments: &[&str]) -> Result<Vec<u8>, String> {
    let output = git(root, arguments);
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            arguments.join(" "),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(output.stdout)
}

fn base_revision(root: &Path, selected: Option<&str>) -> Result<String, String> {
    let base = match selected.filter(|value| !value.is_empty()) {
        Some(value) => value.to_owned(),
        None => String::from_utf8(git_bytes(root, &["merge-base", "HEAD", "origin/main"])?)
            .map_err(|error| error.to_string())?
            .trim()
            .to_owned(),
    };
    if base.len() != 40 || !base.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("BASE_SHA must select a full existing 40-digit commit SHA".into());
    }
    git_bytes(root, &["cat-file", "-e", &format!("{base}^{{commit}}")])?;
    Ok(base)
}

fn names(bytes: &[u8], selected: &mut BTreeSet<String>) -> Result<(), String> {
    if !bytes.is_empty() && !bytes.ends_with(&[0]) {
        return Err("Git returned an incomplete NUL-delimited path listing".into());
    }
    for name in bytes
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
    {
        let text = std::str::from_utf8(name).map_err(|error| error.to_string())?;
        if !Path::new(text)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        {
            return Err("Git source paths must stay within the selected repository".into());
        }
        selected.insert(text.to_owned());
    }
    Ok(())
}

fn python(name: &str, prefix: &[u8]) -> bool {
    if Path::new(name).extension().is_some_and(|extension| {
        ["py", "pyw", "pyi"].contains(&extension.to_string_lossy().to_ascii_lowercase().as_str())
    }) {
        return true;
    }
    let first = prefix
        .split(|byte| *byte == b'\n')
        .next()
        .unwrap_or_default();
    if !first.starts_with(b"#!") {
        return false;
    }
    String::from_utf8_lossy(first)
        .split(|character: char| !character.is_ascii_alphanumeric() && character != '.')
        .any(|part| {
            let lower = part.to_ascii_lowercase();
            [
                "python",
                "pypy",
                "micropython",
                "jython",
                "ironpython",
                "ipython",
            ]
            .iter()
            .any(|interpreter| lower.starts_with(interpreter))
        })
}

fn current_python(root: &Path, name: &str) -> Result<bool, String> {
    let path = root.join(name);
    let metadata = fs::symlink_metadata(&path).map_err(|error| format!("{name}: {error}"))?;
    if !metadata.is_file() || metadata.is_symlink() {
        return Err(format!(
            "{name}: source must be a regular file, not a symlink or special entry"
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o444 == 0 {
            return Err(format!("{name}: source is unreadable"));
        }
    }
    let mut prefix = Vec::new();
    File::open(&path)
        .and_then(|file| file.take(256).read_to_end(&mut prefix))
        .map_err(|error| format!("{name}: {error}"))?;
    Ok(python(name, &prefix))
}

fn check(root: &Path, selected_base: Option<&str>) -> Result<(), String> {
    let base = base_revision(root, selected_base)?;
    let mut changed = BTreeSet::new();
    names(
        &git_bytes(
            root,
            &[
                "diff",
                "--no-ext-diff",
                "--no-renames",
                "--diff-filter=ACMRTU",
                "--name-only",
                "-z",
                &base,
                "--",
            ],
        )?,
        &mut changed,
    )?;
    names(
        &git_bytes(root, &["ls-files", "--others", "--exclude-standard", "-z"])?,
        &mut changed,
    )?;
    let mut forbidden = Vec::new();
    for name in changed {
        if !current_python(root, &name)? {
            continue;
        }
        let original = git(root, &["show", "--no-textconv", &format!("{base}:{name}")]);
        if !original.status.success() || !python(&name, &original.stdout) {
            forbidden.push(name);
        }
    }
    if forbidden.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Use Rust or TypeScript; new first-party Python is not allowed:\n{}",
            forbidden.join("\n")
        ))
    }
}

#[test]
fn repository_does_not_add_first_party_python() {
    let base = std::env::var_os("BASE_SHA");
    let selected = base
        .as_deref()
        .map(|value| value.to_str().expect("BASE_SHA must be valid UTF-8"));
    assert_eq!(check(&workspace_root(), selected), Ok(()));
}

#[test]
fn rejects_untracked_staged_and_committed_additions() {
    for phase in ["untracked", "staged", "committed"] {
        let root = TestDir::new();
        let base = fixture_commit(root.path());
        root.write("new.py", "print('fixture')\n");
        if phase != "untracked" {
            assert!(git(root.path(), &["add", "new.py"]).status.success());
        }
        if phase == "committed" {
            fixture_commit(root.path());
        }
        assert!(
            check(root.path(), Some(&base))
                .expect_err("new Python must fail")
                .contains("new.py")
        );
    }
}

#[test]
fn detects_python_shebangs_and_existing_non_python_conversions() {
    for (name, shebang) in [
        ("tool", "#!/usr/bin/env -S python3.14t -I\n"),
        ("tool.sh", "#!/usr/bin/python3\n"),
        ("pypy-tool", "#!/usr/bin/pypy3\n"),
        ("micro-tool", "#!/usr/bin/env micropython\n"),
        ("java-tool", "#!/usr/bin/jython\n"),
        ("iron-tool", "#!/usr/bin/env IronPython\n"),
        ("interactive-tool", "#!/usr/bin/env ipython\n"),
    ] {
        let root = TestDir::new();
        root.write(name, "#!/bin/sh\n");
        let base = fixture_commit(root.path());
        root.write(name, shebang);
        assert!(check(root.path(), Some(&base)).is_err());
    }
    for name in ["new.PY", "new.pyw", "new.pyi"] {
        let root = TestDir::new();
        let base = fixture_commit(root.path());
        root.write(name, "# fixture\n");
        assert!(check(root.path(), Some(&base)).is_err());
    }
}

#[test]
fn permits_existing_python_repairs_and_deletion_while_migrating() {
    let root = TestDir::new();
    root.write("existing.py", "# existing implementation\n");
    let remove = root.write("remove.py", "# obsolete implementation\n");
    let base = fixture_commit(root.path());
    root.write("existing.py", "# bounded compatibility repair\n");
    fs::remove_file(remove).expect("remove owned obsolete fixture");
    root.write("replacement.rs", "fn main() {}\n");
    assert_eq!(check(root.path(), Some(&base)), Ok(()));
}

#[test]
fn missing_or_invalid_base_refuses_instead_of_skipping_the_policy() {
    let root = TestDir::new();
    fixture_commit(root.path());
    for base in [
        Some("--help"),
        Some("main"),
        Some("0000000000000000000000000000000000000000"),
        None,
    ] {
        assert!(check(root.path(), base).is_err());
    }
}

#[cfg(unix)]
#[test]
fn symlink_or_unreadable_candidates_cannot_hide_a_python_interpreter() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = TestDir::new();
    let base = fixture_commit(root.path());
    let outside = TestDir::new();
    let source = outside.write("python", "#!/usr/bin/python3\n");
    symlink(&source, root.path().join("tool")).expect("owned link fixture");
    assert!(check(root.path(), Some(&base)).is_err());
    fs::remove_file(root.path().join("tool")).expect("remove owned link only");
    let source = root.write("tool", "#!/usr/bin/python3\n");
    fs::set_permissions(&source, fs::Permissions::from_mode(0o000))
        .expect("owned unreadable fixture");
    let result = check(root.path(), Some(&base));
    fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).expect("restore owned fixture");
    assert!(result.is_err());
}
