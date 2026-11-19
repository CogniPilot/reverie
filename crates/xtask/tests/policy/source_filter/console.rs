//! Audit the console's actual derivation against selected edits.
use super::{Nix, index, index_entry};
use crate::support::TestDir;
use std::{
    collections::BTreeSet,
    fs,
    os::unix::fs::symlink,
    path::{Component, Path, PathBuf},
};

const RAW: &str =
    "(import (repo + \"/nix/package.nix\") { inherit pkgs; src = fixture; }).console.drvPath";
const FILTERED: &str = r#"
   let src = import (repo + "/nix/source-filter.nix") { inherit (pkgs) lib; src = fixture; };
   in (import (repo + "/nix/package.nix") { inherit pkgs src; }).console.drvPath"#;

#[test]
fn console_derivation_tracks_its_sources_and_every_declared_fixture() {
    let Some(nix) = Nix::available() else {
        return;
    };
    let Some(files) = index(&nix.root) else {
        return;
    };
    let temp = TestDir::new();
    let consumed = prepare(&nix.root, &temp, &files);
    let baseline = nix.eval(FILTERED, temp.path());
    assert!(baseline.as_str().unwrap().ends_with(".drv"));
    // The raw and filtered inputs select the same build. Use the raw input for
    // each mutation so unrelated changes do not copy the complete source again.
    assert_eq!(nix.eval(RAW, temp.path()), baseline);
    unrelated_edits(&temp);
    assert_eq!(nix.eval(RAW, temp.path()), baseline);
    assert_eq!(nix.eval(FILTERED, temp.path()), baseline);
    for path in &consumed {
        let target = temp.path().join(path);
        assert!(
            fs::symlink_metadata(&target).unwrap().file_type().is_file()
                && target.canonicalize().unwrap().starts_with(temp.path()),
            "expected an owned fixture file at {}",
            target.display()
        );
        let content = fs::read_to_string(&target).unwrap();
        let changed = if path == Path::new("apps/web/package.json") {
            content.replace("1.0.0", "1.0.1")
        } else {
            format!("{content}\nchanged selected input\n")
        };
        assert_ne!(
            changed,
            content,
            "fixture must change at {}",
            path.display()
        );
        fs::write(&target, changed).unwrap();
        assert_ne!(
            nix.eval(RAW, temp.path()),
            baseline,
            "ignored {}",
            path.display()
        );
        fs::write(target, content).unwrap();
    }
    assert_eq!(nix.eval(RAW, temp.path()), baseline);
}

fn prepare(root: &Path, temp: &TestDir, files: &str) -> BTreeSet<PathBuf> {
    for name in ["Cargo.toml", "Cargo.lock", "nix/package.nix"] {
        copy_file(root, temp.path(), name, false);
    }
    // Cargo uses a member glob. Select the actual tracked crate and vendor
    // contents, without interpreting a glob as a literal filesystem path.
    for entry in files.split_terminator('\0').map(index_entry) {
        if entry.path.starts_with("crates/") || entry.path.starts_with("vendor/") {
            copy_file(root, temp.path(), entry.path, entry.kind == "symlink");
        }
    }
    temp.write("apps/web/package.json", "{\"version\":\"1.0.0\"}\n");
    let mut consumed = [
        "skills/reverie/SKILL.md",
        "apps/web/src/example.ts",
        "apps/web/package.json",
        "crates/reverie-application/src/installing_broker/goal_custody/tests/web_fixture.rs",
        "crates/reverie-routes/src/lib.rs",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect::<BTreeSet<_>>();
    for path in ["skills/reverie/SKILL.md", "apps/web/src/example.ts"] {
        temp.write(path, "fixture\n");
    }
    let package = fs::read_to_string(root.join("nix/package.nix")).unwrap();
    for fixture in console_fixtures(&package) {
        let relative = if root.join(fixture).is_dir() {
            Path::new(fixture).join("source-audit.txt")
        } else {
            PathBuf::from(fixture)
        };
        if !temp.path().join(&relative).exists() {
            temp.write(relative.to_str().unwrap(), "fixture\n");
        }
        consumed.insert(relative);
    }
    consumed
}

fn console_fixtures(package: &str) -> BTreeSet<&str> {
    let result = package
        .match_indices("consoleFixture ")
        .filter_map(|(offset, call)| {
            package[offset + call.len()..]
                .trim_start()
                .strip_prefix('"')?
                .split_once('"')
                .map(|(value, _)| value)
        })
        .collect::<BTreeSet<_>>();
    assert!(
        result.len() > 10,
        "use the actual explicitly named console fixtures"
    );
    for path in &result {
        assert!(
            !path.is_empty()
                && Path::new(path)
                    .components()
                    .all(|part| matches!(part, Component::Normal(_)))
        );
    }
    result
}

fn copy_file(src: &Path, root: &Path, relative: &str, is_symlink: bool) {
    let destination = root.join(relative);
    let source = src.join(relative);
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    if is_symlink {
        symlink(fs::read_link(source).unwrap(), destination).unwrap();
    } else {
        fs::copy(source, destination).unwrap();
    }
}

fn unrelated_edits(temp: &TestDir) {
    temp.write("README.md", "Unrelated documentation edit.\n");
    temp.write("python/reverie/unused.py", "Unrelated legacy source.\n");
    temp.write(
        "crates/reverie-core/target/cache-entry",
        "Unrelated build result.\n",
    );
    temp.write(
        "crates/reverie-core/.git/index",
        "Unrelated Git metadata.\n",
    );
    temp.write(
        "crates/unrelated/Cargo.toml",
        "[package]\nname = \"unrelated\"\nversion = \"1.0.0\"\n",
    );
    let cargo = fs::read_to_string(temp.path().join("Cargo.toml")).unwrap();
    let unused = cargo.replacen(
        "[workspace.dependencies]",
        "[workspace.dependencies]\nunrelated = \"1\"",
        1,
    );
    assert_ne!(unused, cargo);
    temp.write("Cargo.toml", unused);
    let lock = fs::read_to_string(temp.path().join("Cargo.lock")).unwrap();
    temp.write(
        "Cargo.lock",
        format!("{lock}\n[[package]]\nname = \"unrelated\"\nversion = \"1.0.0\"\n"),
    );
}
