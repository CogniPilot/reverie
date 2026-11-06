//! Budget policy from Rumoca SPEC_0000 and its spec_budget_test.rs at
//! 0bab7e08c42dced38488abd298a4b9bb77d2b0cc, independently implemented.

use crate::support::{TestDir, workspace_root};
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

const ACTIVE_CAP: usize = 21;
const WORD_CAP: usize = 2500;
const LINE_CAP: usize = 350;

fn status(content: &str, identifier: &str) -> Result<String, String> {
    // Required canonical opening from SPEC_0000; blank lines are harmless.
    // Do not interpret an example/fenced later status marker as the real one.
    let mut lines = content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let heading = format!("# SPEC_{identifier}:");
    if !lines.next().is_some_and(|line| line.starts_with(&heading))
        || lines.next() != Some("## Status")
    {
        return Err("spec must begin with its # SPEC_NNNN: title and ## Status section".into());
    }
    let value = lines.next().unwrap_or_default().to_owned();
    if !["ACCEPTED", "DRAFT", "REFERENCE"].contains(&value.as_str()) {
        return Err("spec status must be ACCEPTED, DRAFT or REFERENCE".into());
    }
    Ok(value)
}

fn check(root: &Path) -> Result<(), String> {
    check_with_sequence(root, false)
}

fn check_with_sequence(root: &Path, require_sequence: bool) -> Result<(), String> {
    if !super::size::inspect(root)?.is_dir()
        || fs::canonicalize(root).map_err(|error| error.to_string())? != root
    {
        return Err("spec root must be an existing canonical readable directory".into());
    }
    let mut active = 0;
    let mut identifiers = BTreeSet::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = super::size::inspect(&path)?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "spec names must be UTF-8")?;
        if !name.starts_with("SPEC_") || !name.ends_with(".md") {
            continue;
        }
        if !metadata.is_file() {
            return Err(format!("{name}: spec must be a regular readable file"));
        }
        let id = name
            .get(5..9)
            .filter(|id| id.bytes().all(|byte| byte.is_ascii_digit()))
            .ok_or_else(|| format!("{name}: missing four-digit spec identifier"))?;
        if !matches!(name.as_bytes().get(9), Some(b'_' | b'.')) {
            return Err(format!(
                "{name}: spec identifier must contain exactly four digits"
            ));
        }
        if !identifiers.insert(id.to_owned()) {
            return Err(format!("SPEC_{id}: duplicate identifier"));
        }
        let content = fs::read_to_string(&path).map_err(|error| format!("{name}: {error}"))?;
        let value = status(&content, id).map_err(|error| format!("{name}: {error}"))?;
        if value == "REFERENCE" {
            continue;
        }
        active += 1;
        let words = content.split_whitespace().count();
        let lines = content.lines().count();
        if words > WORD_CAP || lines > LINE_CAP {
            return Err(format!(
                "{name}: {lines} lines/{words} words exceeds {LINE_CAP} lines/{WORD_CAP} words"
            ));
        }
    }
    if identifiers.is_empty() {
        return Err("no specifications found".into());
    }
    if active > ACTIVE_CAP {
        return Err(format!(
            "{active} ACCEPTED+DRAFT specs exceeds {ACTIVE_CAP}"
        ));
    }
    if require_sequence {
        for (expected, identifier) in identifiers.iter().enumerate() {
            if identifier.parse::<usize>().ok() != Some(expected) {
                return Err(format!(
                    "spec adoption order must be sequential: expected SPEC_{expected:04}, found SPEC_{identifier}"
                ));
            }
        }
    }
    Ok(())
}

#[test]
fn repository_specs_stay_within_rumoca_budgets() {
    assert_eq!(
        check_with_sequence(&workspace_root().join("spec"), true),
        Ok(())
    );
}

fn prefix(identifier: usize, value: &str) -> String {
    format!("# SPEC_{identifier:04}: Fixture\n\n## Status\n\n{value}\n\n")
}

#[test]
fn exactly_twenty_one_active_specs_pass_and_twenty_two_fail() {
    let root = TestDir::new();
    for identifier in 0..21 {
        let value = if identifier % 2 == 0 {
            "ACCEPTED"
        } else {
            "DRAFT"
        };
        root.write(
            &format!("SPEC_{identifier:04}_FIXTURE.md"),
            prefix(identifier, value),
        );
    }
    assert_eq!(check(root.path()), Ok(()));
    root.write(
        "SPEC_0099_CATALOG.md",
        format!(
            "{}{}{}",
            prefix(99, "REFERENCE"),
            "catalog\n".repeat(351),
            "catalog ".repeat(2501)
        ),
    );
    assert_eq!(check(root.path()), Ok(()));
    root.write("SPEC_0021_FIXTURE.md", prefix(21, "DRAFT"));
    assert!(
        check(root.path())
            .expect_err("22 active specs must fail")
            .contains("22 ACCEPTED+DRAFT")
    );
}

#[test]
fn exact_line_and_word_caps_pass_but_the_next_unit_fails() {
    for value in ["ACCEPTED", "DRAFT"] {
        let root = TestDir::new();
        let opening = prefix(1, value);
        let source = format!(
            "{opening}{}",
            "line\n".repeat(LINE_CAP - opening.lines().count())
        );
        assert_eq!(source.lines().count(), LINE_CAP);
        root.write("SPEC_0001_FIXTURE.md", &source);
        assert_eq!(check(root.path()), Ok(()));
        root.write("SPEC_0001_FIXTURE.md", format!("{source}one more line\n"));
        assert!(check(root.path()).is_err());
        let source = format!(
            "{opening}{}",
            "word ".repeat(WORD_CAP - opening.split_whitespace().count())
        );
        assert_eq!(source.split_whitespace().count(), WORD_CAP);
        root.write("SPEC_0001_FIXTURE.md", &source);
        assert_eq!(check(root.path()), Ok(()));
        root.write("SPEC_0001_FIXTURE.md", format!("{source}extra"));
        assert!(check(root.path()).is_err());
    }
}

#[test]
fn malformed_or_missing_status_cannot_escape_the_active_count() {
    for source in [
        "# SPEC_0001: Fixture\n",
        "# SPEC_0001: Fixture\n\n## Status\nUNKNOWN\n",
        "# SPEC_0001: Fixture\n\n## Status\ndraft\n",
        "# SPEC_0001: Fixture\n\n## Summary\nBefore status\n\n## Status\nDRAFT\n",
        "# SPEC_0001: Fixture\n\n```md\n## Status\nREFERENCE\n```\n",
    ] {
        let root = TestDir::new();
        root.write("SPEC_0001_FIXTURE.md", source);
        assert!(check(root.path()).is_err());
    }
}

#[test]
fn filenames_and_headings_agree_and_identifiers_are_unique() {
    let root = TestDir::new();
    root.write("SPEC_0001_FIXTURE.md", prefix(2, "DRAFT"));
    assert!(check(root.path()).is_err());
    root.write("SPEC_0001_FIXTURE.md", prefix(1, "DRAFT"));
    assert_eq!(check(root.path()), Ok(()));
    root.write("SPEC_0001_DUPLICATE.md", prefix(1, "DRAFT"));
    assert!(check(root.path()).is_err());
}

#[test]
fn missing_or_invalid_utf8_specs_fail_instead_of_skipping() {
    let root = TestDir::new();
    assert!(check(&root.path().join("missing")).is_err());
    assert!(
        check(root.path()).is_err(),
        "an empty spec set is not accepted"
    );
    root.write("SPEC_0001_FIXTURE.md", [0xff]);
    assert!(check(root.path()).is_err());
}

#[cfg(unix)]
#[test]
fn spec_symlinks_and_unreadable_entries_do_not_bypass_the_gate() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = TestDir::new();
    let path = root.write("SPEC_0001_FIXTURE.md", prefix(1, "DRAFT"));
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000))
        .expect("owned unreadable fixture");
    let result = check(root.path());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("restore owned fixture");
    assert!(result.is_err());
    let outside = TestDir::new();
    let source = outside.write("spec.md", prefix(2, "DRAFT"));
    symlink(source, root.path().join("SPEC_0002_LINK.md")).expect("owned spec link");
    assert!(check(root.path()).is_err());
}

#[test]
fn adoption_numbers_are_sequential_and_reference_slots_stay_reserved() {
    let root = TestDir::new();
    root.write("SPEC_0000_FIRST.md", prefix(0, "ACCEPTED"));
    root.write("SPEC_0002_THIRD.md", prefix(2, "DRAFT"));
    assert!(check_with_sequence(root.path(), true).is_err());
    root.write("SPEC_0001_RETIRED.md", prefix(1, "REFERENCE"));
    assert_eq!(check_with_sequence(root.path(), true), Ok(()));
}
