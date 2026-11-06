//! Prevent new Python/shell scripts while legacy implementations migrate.
//! Check the worktree and index plus nonignored untracked files, so local verify
//! and PR CI apply the same rule before or after a commit.

use crate::support::{TestDir, fixture_commit, git, workspace_root};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Component, Path};
use std::process::{Command, Stdio};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Language {
    Python,
    Shell,
}

fn script(name: &str, prefix: &[u8]) -> Option<Language> {
    if python(name, prefix) {
        return Some(Language::Python);
    }
    if Path::new(name).extension().is_some_and(|extension| {
        [
            "sh", "bash", "zsh", "ksh", "csh", "fish", "ps1", "bat", "cmd",
        ]
        .contains(&extension.to_string_lossy().to_ascii_lowercase().as_str())
    }) {
        return Some(Language::Shell);
    }
    let first = prefix
        .split(|byte| *byte == b'\n')
        .next()
        .unwrap_or_default();
    if !first.starts_with(b"#!") {
        return None;
    }
    String::from_utf8_lossy(first)
        .split(|character: char| !character.is_ascii_alphanumeric() && character != '.')
        .any(|part| {
            let lower = part.to_ascii_lowercase();
            let interpreter = lower.strip_suffix(".exe").unwrap_or(&lower);
            [
                "sh",
                "bash",
                "dash",
                "zsh",
                "ksh",
                "csh",
                "tcsh",
                "fish",
                "pwsh",
                "powershell",
                "cmd",
            ]
            .contains(&interpreter)
        })
        .then_some(Language::Shell)
}

fn current_script(root: &Path, name: &str) -> Result<Option<Language>, String> {
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
    Ok(script(name, &prefix))
}

fn changed_names(root: &Path, base: &str, cached: bool) -> Result<BTreeSet<String>, String> {
    let mut changed = BTreeSet::new();
    let mut arguments = vec![
        "diff",
        "--no-ext-diff",
        "--no-renames",
        "--diff-filter=ACMRTU",
        "--name-only",
        "-z",
    ];
    if cached {
        arguments.push("--cached");
    }
    arguments.extend([base, "--"]);
    names(&git_bytes(root, &arguments)?, &mut changed)?;
    Ok(changed)
}

fn listing_entry(bytes: &[u8], name: &str) -> Result<Option<[String; 3]>, String> {
    if bytes.is_empty() {
        return Ok(None);
    }
    let record = bytes
        .strip_suffix(&[0])
        .ok_or("Git source entry is not NUL terminated")?;
    if record.contains(&0) {
        return Err("Git returned multiple entries for a literal source path".into());
    }
    let text = std::str::from_utf8(record).map_err(|error| error.to_string())?;
    let (metadata, path) = text
        .split_once('\t')
        .ok_or("Git source entry has no metadata separator")?;
    let fields: Vec<&str> = metadata.split_whitespace().collect();
    if path != name || fields.len() != 3 {
        return Err("Git source entry does not match the selected path".into());
    }
    Ok(Some([
        fields[0].to_owned(),
        fields[1].to_owned(),
        fields[2].to_owned(),
    ]))
}

fn index_blob(root: &Path, name: &str) -> Result<String, String> {
    let bytes = git_bytes(
        root,
        &[
            "--literal-pathspecs",
            "ls-files",
            "--stage",
            "-z",
            "--",
            name,
        ],
    )?;
    let [mode, object, stage] =
        listing_entry(&bytes, name)?.ok_or("changed index source is absent")?;
    if !["100644", "100755"].contains(&mode.as_str()) || stage != "0" {
        return Err(format!(
            "{name}: index source must be a regular, merged blob"
        ));
    }
    Ok(object)
}

fn blob_prefix(root: &Path, object: &str) -> Result<Vec<u8>, String> {
    if ![40, 64].contains(&object.len()) || !object.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Git source entry has an invalid object ID".into());
    }
    let mut child = Command::new("git")
        .args(["cat-file", "blob", object])
        .current_dir(root)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    let result = {
        let mut output = child.stdout.take().expect("configured Git stdout pipe");
        let mut prefix = Vec::new();
        let read = (&mut output)
            .take(256)
            .read_to_end(&mut prefix)
            .and_then(|_| io::copy(&mut output, &mut io::sink()));
        read.map(|_| prefix).map_err(|error| error.to_string())
    };
    let status = child.wait().map_err(|error| error.to_string())?;
    if !status.success() {
        return Err(format!("git cat-file blob failed: {status}"));
    }
    result
}

fn baseline_script(root: &Path, base: &str, name: &str) -> Result<Option<Language>, String> {
    let bytes = git_bytes(
        root,
        &["--literal-pathspecs", "ls-tree", "-z", base, "--", name],
    )?;
    let Some([mode, kind, object]) = listing_entry(&bytes, name)? else {
        return Ok(None);
    };
    if kind != "blob" || !["100644", "100755"].contains(&mode.as_str()) {
        return Ok(None);
    }
    Ok(script(name, &blob_prefix(root, &object)?))
}

fn check(root: &Path, selected_base: Option<&str>) -> Result<(), String> {
    let base = base_revision(root, selected_base)?;
    if !git_bytes(root, &["ls-files", "--unmerged", "-z"])?.is_empty() {
        return Err("Script policy cannot verify an unmerged index".into());
    }
    let mut forbidden = Vec::new();
    for name in changed_names(root, &base, true)? {
        let language = script(&name, &blob_prefix(root, &index_blob(root, &name)?)?);
        if language.is_some() && baseline_script(root, &base, &name)? != language {
            forbidden.push(format!("{name} (index)"));
        }
    }
    let mut changed = changed_names(root, &base, false)?;
    names(
        &git_bytes(root, &["ls-files", "--others", "--exclude-standard", "-z"])?,
        &mut changed,
    )?;
    for name in changed {
        let Some(language) = current_script(root, &name)? else {
            continue;
        };
        if baseline_script(root, &base, &name)? != Some(language) {
            forbidden.push(format!("{name} (worktree)"));
        }
    }
    if forbidden.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Use Rust or TypeScript; new first-party Python or shell scripts are not allowed:\n{}",
            forbidden.join("\n")
        ))
    }
}

#[test]
fn repository_does_not_add_first_party_scripts() {
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
fn staged_script_cannot_hide_behind_a_clean_or_missing_worktree_file() {
    for source in ["#!/usr/bin/env python3\n", "#!/usr/bin/env bash\n"] {
        for existing in [false, true] {
            let root = TestDir::new();
            if existing {
                root.write("tool", "// clean Rust baseline\n");
            }
            let base = fixture_commit(root.path());
            let path = root.write("tool", source);
            assert!(git(root.path(), &["add", "tool"]).status.success());
            root.write("tool", "// clean Rust baseline\n");
            assert!(
                check(root.path(), Some(&base))
                    .expect_err("index script must fail")
                    .contains("tool (index)")
            );
            fs::remove_file(path).expect("remove only owned worktree fixture");
            assert!(
                check(root.path(), Some(&base))
                    .expect_err("missing worktree cannot hide index")
                    .contains("tool (index)")
            );
        }
    }
}

#[test]
fn clean_staged_blob_does_not_hide_a_worktree_script() {
    for source in ["#!/usr/bin/python3\n", "#!/bin/sh\n"] {
        let root = TestDir::new();
        let base = fixture_commit(root.path());
        root.write("tool", "// clean staged Rust\n");
        assert!(git(root.path(), &["add", "tool"]).status.success());
        root.write("tool", source);
        assert!(
            check(root.path(), Some(&base))
                .expect_err("worktree script must fail")
                .contains("tool (worktree)")
        );
    }
}

#[test]
fn independently_checking_index_retains_legacy_repairs_and_staged_deletions() {
    for source in ["#!/usr/bin/python3\n", "#!/bin/bash\n"] {
        let root = TestDir::new();
        root.write("legacy-tool", source);
        root.write("obsolete-tool", source);
        let base = fixture_commit(root.path());
        root.write("legacy-tool", format!("{source}# bounded legacy repair\n"));
        assert!(git(root.path(), &["add", "legacy-tool"]).status.success());
        root.write("legacy-tool", "// worktree Rust replacement\n");
        assert!(
            git(root.path(), &["rm", "--quiet", "obsolete-tool"])
                .status
                .success()
        );
        assert_eq!(check(root.path(), Some(&base)), Ok(()));
    }
}

#[test]
fn blob_reader_keeps_a_bounded_prefix_and_reports_git_errors() {
    let root = TestDir::new();
    let base = fixture_commit(root.path());
    root.write(
        "large-tool",
        format!("#!/bin/bash\n{}", "x".repeat(1_048_576)),
    );
    assert!(git(root.path(), &["add", "large-tool"]).status.success());
    let object = index_blob(root.path(), "large-tool").unwrap();
    let prefix = blob_prefix(root.path(), &object).unwrap();
    assert_eq!(prefix.len(), 256);
    assert_eq!(script("large-tool", &prefix), Some(Language::Shell));
    assert!(check(root.path(), Some(&base)).is_err());
    assert!(blob_prefix(root.path(), "0000000000000000000000000000000000000000").is_err());
}

#[test]
fn an_unmerged_index_is_not_replaced_by_clean_worktree_evidence() {
    let root = TestDir::new();
    root.write("tool", "baseline\n");
    let base = fixture_commit(root.path());
    root.write("tool", "left\n");
    let left = fixture_commit(root.path());
    assert!(
        git(root.path(), &["checkout", "--quiet", &base])
            .status
            .success()
    );
    root.write("tool", "right\n");
    fixture_commit(root.path());
    assert!(
        !git(
            root.path(),
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "merge",
                "--no-edit",
                &left
            ]
        )
        .status
        .success()
    );
    assert!(
        !git_bytes(root.path(), &["ls-files", "--unmerged", "-z"])
            .unwrap()
            .is_empty()
    );
    root.write("tool", "// clean-looking Rust resolution without staging\n");
    assert!(
        check(root.path(), Some(&base))
            .expect_err("unmerged index must fail")
            .contains("unmerged index")
    );
}

#[cfg(unix)]
#[test]
fn staged_symlink_is_not_hidden_by_a_regular_worktree_replacement() {
    use std::os::unix::fs::symlink;
    let root = TestDir::new();
    let base = fixture_commit(root.path());
    root.write("target", "#!/bin/bash\n");
    symlink("target", root.path().join("tool")).expect("owned staged link");
    assert!(git(root.path(), &["add", "tool"]).status.success());
    fs::remove_file(root.path().join("tool")).expect("remove only owned link");
    root.write("tool", "// regular clean Rust worktree\n");
    let error = check(root.path(), Some(&base)).expect_err("index symlink must fail");
    assert!(error.contains("index source must be a regular, merged blob"));
}

#[cfg(unix)]
#[test]
fn literal_index_paths_preserve_special_names_and_nul_delimiters() {
    for name in [
        "-tool",
        ":(glob)tool",
        "nested/tool",
        "tab\ttool",
        "line\ntool",
    ] {
        let root = TestDir::new();
        root.write(name, "// clean baseline\n");
        let base = fixture_commit(root.path());
        root.write(name, "#!/bin/bash\n");
        assert!(
            git(root.path(), &["--literal-pathspecs", "add", "--", name])
                .status
                .success()
        );
        root.write(name, "// clean baseline\n");
        let error = check(root.path(), Some(&base)).expect_err("literal index script must fail");
        assert!(error.contains(&format!("{name} (index)")), "{error}");
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

#[test]
fn rejects_shell_extensions_and_extensionless_interpreters() {
    for (name, source) in [
        ("deploy.sh", "echo fixture\n"),
        ("tool.BASH", "echo fixture\n"),
        ("tool.zsh", "echo fixture\n"),
        ("tool.ps1", "Write-Output fixture\n"),
        ("tool.cmd", "@echo fixture\n"),
        ("tool.bat", "@echo fixture\n"),
        ("deploy", "#!/usr/bin/env bash\n"),
        ("deploy", "#!/usr/bin/env -S bash -eu\n"),
        ("deploy", "#!/bin/sh\n"),
        ("deploy", "#!/usr/bin/env pwsh\n"),
    ] {
        let root = TestDir::new();
        let base = fixture_commit(root.path());
        root.write(name, source);
        assert!(check(root.path(), Some(&base)).is_err(), "{name}");
    }
}

#[test]
fn detects_shell_conversions_but_allows_typescript_and_rust() {
    let root = TestDir::new();
    root.write("tool", "#!/usr/bin/env node\n");
    let base = fixture_commit(root.path());
    root.write("new.ts", "export {};\n");
    root.write("new.rs", "fn main() {}\n");
    assert_eq!(check(root.path(), Some(&base)), Ok(()));
    root.write("tool", "#!/usr/bin/env bash\n");
    assert!(check(root.path(), Some(&base)).is_err());
}

#[test]
fn repository_reports_legacy_script_inventory_for_migration() {
    use std::io::Write;
    let root = workspace_root();
    let mut tracked = BTreeSet::new();
    names(
        &git_bytes(&root, &["ls-files", "-z"]).expect("tracked source"),
        &mut tracked,
    )
    .expect("source paths");
    let mut scripts = Vec::new();
    for name in tracked {
        let path = root.join(&name);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => panic!("cannot inventory {name}: {error}"),
        };
        if metadata.is_file()
            && let Some(language) = current_script(&root, &name).expect("read tracked source")
        {
            scripts.push(format!("{language:?}: {name}"));
        }
    }
    let report = format!(
        "## Legacy script migration debt\n\n{} tracked Python/shell scripts remain. These are not a deletion GO; new scripts are rejected separately.\n\n<details><summary>Script inventory</summary>\n\n```text\n{}\n```\n\n</details>\n",
        scripts.len(),
        scripts.join("\n")
    );
    println!("{report}");
    if let Some(path) = std::env::var_os("GITHUB_STEP_SUMMARY") {
        let mut file = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
            .expect("CI summary");
        file.write_all(report.as_bytes())
            .expect("script inventory summary");
    }
}

#[test]
fn existing_shell_repairs_and_deletion_remain_possible_during_migration() {
    let root = TestDir::new();
    root.write("existing.sh", "echo old\n");
    let obsolete = root.write("obsolete", "#!/bin/bash\necho old\n");
    let base = fixture_commit(root.path());
    root.write("existing.sh", "echo bounded-compatibility-repair\n");
    fs::remove_file(obsolete).expect("remove obsolete owned fixture");
    assert_eq!(check(root.path(), Some(&base)), Ok(()));
}
