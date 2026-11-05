//! Policy derived from CogniPilot/rumoca 0bab7e08c42dced38488abd298a4b9bb77d2b0cc,
//! crates/rumoca/tests/suite_gates/code_size_budget_test.rs (SPEC_0021).
//! Independent implementation: same 2000-line production budget and source
//! exclusions; no content-marker exceptions and no traversal through symlinks.

use crate::support::{TestDir, workspace_root};
use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};

const MAX_LINES: usize = 2000;

fn excluded(relative: &Path) -> bool {
    relative
        .components()
        .any(|part| part.as_os_str() == "tests" || part.as_os_str() == "generated")
        || relative.file_name().is_some_and(|name| name == "tests.rs")
        || relative
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with("_tests.rs"))
}

fn readable(metadata: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode();
        mode & 0o444 != 0 && (!metadata.is_dir() || mode & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        true
    }
}

pub(super) fn inspect(path: &Path) -> Result<Metadata, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if metadata.is_symlink() || (!metadata.is_dir() && !metadata.is_file()) || !readable(&metadata)
    {
        return Err(format!(
            "{}: symlink, special or unreadable source entry",
            path.display()
        ));
    }
    Ok(metadata)
}

fn check(root: &Path) -> Result<(), String> {
    if !inspect(root)?.is_dir()
        || fs::canonicalize(root).map_err(|error| error.to_string())? != root
    {
        return Err("Rust source root must be an existing canonical directory".into());
    }
    let mut pending = vec![root.to_path_buf()];
    let mut offenders = Vec::new();
    while let Some(directory) = pending.pop() {
        let entries = fs::read_dir(&directory)
            .map_err(|error| format!("{}: {error}", directory.display()))?;
        for entry in entries {
            let path = entry.map_err(|error| error.to_string())?.path();
            if inspect(&path)?.is_dir() {
                pending.push(path);
            } else {
                count_source(root, &path, &mut offenders)?;
            }
        }
    }
    offenders.sort();
    if offenders.is_empty() {
        Ok(())
    } else {
        Err(offenders.join("\n"))
    }
}

fn count_source(root: &Path, path: &Path, offenders: &mut Vec<String>) -> Result<(), String> {
    let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
    if path.extension().is_none_or(|extension| extension != "rs") || excluded(relative) {
        return Ok(());
    }
    let source =
        fs::read_to_string(path).map_err(|error| format!("{}: {error}", relative.display()))?;
    let lines = source.lines().count();
    if lines > MAX_LINES {
        offenders.push(format!(
            "{}: {lines} lines exceeds {MAX_LINES}; split production Rust into focused modules",
            relative.display()
        ));
    }
    Ok(())
}

#[test]
fn production_rust_stays_within_rumoca_size_budget() {
    assert_eq!(check(&workspace_root().join("crates")), Ok(()));
}

#[test]
fn exact_boundary_and_rust_line_endings_match_rumoca() {
    for contents in [
        "line\n".repeat(2000),
        "line\r\n".repeat(2000),
        format!("{}last", "line\n".repeat(1999)),
    ] {
        let root = TestDir::new();
        root.write("sample/src/lib.rs", contents);
        assert_eq!(check(root.path()), Ok(()));
    }
    let root = TestDir::new();
    root.write("sample/src/lib.rs", "line\n".repeat(2001));
    assert!(
        check(root.path())
            .expect_err("2001 lines must fail")
            .contains("2001 lines exceeds 2000")
    );
}

#[test]
fn excludes_test_and_generated_sources_only_within_the_scanned_root() {
    let root = TestDir::new();
    for name in [
        "sample/tests/fixture.rs",
        "sample/src/tests.rs",
        "sample/src/parser_tests.rs",
        "sample/generated/parser.rs",
    ] {
        root.write(name, "line\n".repeat(2001));
    }
    assert_eq!(check(root.path()), Ok(()));
    for name in [
        "examples/example.rs",
        "fixtures/fixture.rs",
        "tests_named_root/src/main.rs",
    ] {
        let case = TestDir::new();
        case.write(name, "line\n".repeat(2001));
        assert!(check(case.path()).is_err());
    }
    let path = root.write("tests/src/main.rs", "line\n".repeat(2001));
    let named_tests = path.parent().expect("src").parent().expect("tests");
    assert!(
        check(named_tests).is_err(),
        "ancestor name must not exempt the whole source tree"
    );
}

#[test]
fn marker_comments_do_not_exempt_oversized_production_sources() {
    let root = TestDir::new();
    root.write(
        "src/main.rs",
        format!(
            "// SPEC_0021 file-size split plan\n{}",
            "line\n".repeat(2000)
        ),
    );
    assert!(check(root.path()).is_err());
}

#[test]
fn missing_or_invalid_utf8_production_source_fails() {
    assert!(
        check(&PathBuf::from(
            "/definitely-missing-reverie-rust-source-root"
        ))
        .is_err()
    );
    let root = TestDir::new();
    root.write("src/main.rs", [0xff]);
    assert!(check(root.path()).is_err());
}

#[cfg(unix)]
#[test]
fn unreadable_source_and_symlinks_cannot_bypass_the_gate() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = TestDir::new();
    let path = root.write("src/main.rs", "fn main() {}\n");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o000))
        .expect("owned unreadable fixture");
    let result = check(root.path());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("restore owned fixture");
    assert!(result.is_err());
    let outside = TestDir::new();
    outside.write("oversized.rs", "line\n".repeat(2001));
    symlink(outside.path(), root.path().join("tests")).expect("owned directory link fixture");
    assert!(
        check(root.path()).is_err(),
        "even excluded directory links must refuse"
    );
    fs::remove_file(root.path().join("tests")).expect("remove owned link only");
    symlink(
        outside.path().join("oversized.rs"),
        root.path().join("alias.rs"),
    )
    .expect("owned file link fixture");
    assert!(check(root.path()).is_err());
    assert!(check(&root.path().join("tests")).is_err());
}
