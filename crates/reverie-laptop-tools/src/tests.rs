use super::*;
use crate::cargo::{MergeError, MergeOutcome, test_merge};
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree {
    root: PathBuf,
}
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-laptop-tools-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self { root }
    }
    fn cargo(&self) -> PathBuf {
        self.root.join(".cargo")
    }
    fn config(&self) -> PathBuf {
        self.cargo().join("config.toml")
    }
    fn write(&self, raw: &str) {
        fs::create_dir_all(self.cargo()).unwrap();
        fs::write(self.config(), raw).unwrap();
    }
    fn leftovers(&self) -> usize {
        fs::read_dir(self.cargo())
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(".config-"))
            .count()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn memory_parallelism_clamps_every_threshold_boundary() {
    let tree = Tree::new();
    let gib = 1_u64 << 30;
    for (hard, high, cpus, expected) in [
        (None, None, 8, 1),
        (Some("max".into()), None, 8, 1),
        (Some("0".into()), None, 8, 1),
        (Some("-1".into()), None, 8, 1),
        (Some("invalid".into()), None, 8, 1),
        (Some(gib.to_string()), None, 8, 1),
        (Some((2 * gib - 1).to_string()), None, 8, 1),
        (Some((3 * gib).to_string()), None, 8, 2),
        (Some((12 * gib).to_string()), None, 4, 4),
        (
            Some((12 * gib).to_string()),
            Some((3 * gib).to_string()),
            8,
            2,
        ),
        (
            Some((3 * gib).to_string()),
            Some((12 * gib).to_string()),
            8,
            2,
        ),
        (Some((12 * gib).to_string()), Some("max".into()), 8, 8),
        (None, Some((4 * gib).to_string()), 8, 3),
        (Some((12 * gib).to_string()), None, 0, 1),
        (Some(u64::MAX.to_string()), None, 4, 4),
    ] {
        for name in ["memory.max", "memory.high"] {
            let _ = fs::remove_file(tree.root.join(name));
        }
        if let Some(raw) = hard {
            fs::write(tree.root.join("memory.max"), raw).unwrap();
        }
        if let Some(raw) = high {
            fs::write(tree.root.join("memory.high"), raw).unwrap();
        }
        assert_eq!(build_jobs(&tree.root, cpus), expected);
    }
}
#[test]
fn absent_config_is_created_privately_and_repeated_apply_preserves_it() {
    let tree = Tree::new();
    assert_eq!(merge_cargo_defaults(&tree.root), Ok(MergeOutcome::Merged));
    let bytes = fs::read(tree.config()).unwrap();
    assert_eq!(
        fs::metadata(tree.config()).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        merge_cargo_defaults(&tree.root),
        Ok(MergeOutcome::Preserved)
    );
    assert_eq!(fs::read(tree.config()).unwrap(), bytes);
    assert_eq!(tree.leftovers(), 0);
}
#[test]
fn comments_and_unrelated_settings_are_kept_verbatim() {
    let tree = Tree::new();
    let raw = "# owner config\n[build] # compiler settings\njobs = 3\n\n[target.x86_64-unknown-linux-gnu]\nlinker = 'clang'\n";
    tree.write(raw);
    assert_eq!(merge_cargo_defaults(&tree.root), Ok(MergeOutcome::Merged));
    let updated = fs::read_to_string(tree.config()).unwrap();
    assert_eq!(
        updated.replace(
            "build-dir = \"/tmp/reverie/cargo-build/{workspace-path-hash}\"\n",
            ""
        ),
        raw
    );
    assert_eq!(tree.leftovers(), 0);
}
#[test]
fn a_build_header_without_a_final_newline_is_completed_safely() {
    let tree = Tree::new();
    tree.write("[build]");
    assert_eq!(merge_cargo_defaults(&tree.root), Ok(MergeOutcome::Merged));
    assert!(
        fs::read_to_string(tree.config())
            .unwrap()
            .starts_with("[build]\nbuild-dir")
    );
}
#[test]
fn every_existing_build_dir_value_is_preserved() {
    for raw in [
        "[build]\nbuild-dir='/owner/cache'\n",
        "build = { build-dir = '/owner/cache' }\n",
        "[build]\nbuild-dir=7\n",
    ] {
        let tree = Tree::new();
        tree.write(raw);
        assert_eq!(
            merge_cargo_defaults(&tree.root),
            Ok(MergeOutcome::Preserved)
        );
        assert_eq!(fs::read_to_string(tree.config()).unwrap(), raw);
    }
}
#[test]
fn malformed_duplicate_or_nonstandard_toml_is_never_overwritten() {
    for (raw, error) in [
        ("[build\n", MergeError::InvalidToml),
        ("[build]\njobs=1\njobs=2\n", MergeError::InvalidToml),
        ("build.jobs=4\n", MergeError::NonstandardBuildTable),
        ("build={jobs=4}\n", MergeError::NonstandardBuildTable),
        ("build='text'\n", MergeError::NonstandardBuildTable),
    ] {
        let tree = Tree::new();
        tree.write(raw);
        assert_eq!(merge_cargo_defaults(&tree.root), Err(error));
        assert_eq!(fs::read_to_string(tree.config()).unwrap(), raw);
        assert_eq!(tree.leftovers(), 0);
    }
}
#[test]
fn legacy_config_including_a_dangling_symlink_is_refused() {
    for dangling in [false, true] {
        let tree = Tree::new();
        tree.write("");
        if dangling {
            symlink("missing", tree.cargo().join("config")).unwrap();
        } else {
            fs::write(tree.cargo().join("config"), "[build]\n").unwrap();
        }
        assert_eq!(
            merge_cargo_defaults(&tree.root),
            Err(MergeError::LegacyConfig)
        );
        assert_eq!(fs::read_to_string(tree.config()).unwrap(), "");
    }
}
#[test]
fn symlinked_home_cargo_and_config_and_hardlinked_config_are_refused() {
    let tree = Tree::new();
    let other = tree.root.join("other");
    fs::create_dir(&other).unwrap();
    let home = tree.root.join("home");
    symlink(&other, &home).unwrap();
    assert_eq!(merge_cargo_defaults(&home), Err(MergeError::UnsafeHome));
    symlink(&other, tree.cargo()).unwrap();
    assert_eq!(
        merge_cargo_defaults(&tree.root),
        Err(MergeError::UnsafeHome)
    );
    fs::remove_file(tree.cargo()).unwrap();
    fs::create_dir(tree.cargo()).unwrap();
    for target in [&other.join("missing"), &other.join("file")] {
        if target.file_name().unwrap() == "file" {
            fs::write(target, "").unwrap();
        }
        symlink(target, tree.config()).unwrap();
        assert_eq!(
            merge_cargo_defaults(&tree.root),
            Err(MergeError::UnsafeConfig)
        );
        fs::remove_file(tree.config()).unwrap();
    }
    fs::write(other.join("config"), "").unwrap();
    fs::hard_link(other.join("config"), tree.config()).unwrap();
    assert_eq!(
        merge_cargo_defaults(&tree.root),
        Err(MergeError::UnsafeConfig)
    );
}
#[test]
fn writable_cargo_directory_and_nonregular_oversized_or_nonutf8_configs_are_refused() {
    let tree = Tree::new();
    tree.write("");
    fs::set_permissions(tree.cargo(), fs::Permissions::from_mode(0o777)).unwrap();
    assert_eq!(
        merge_cargo_defaults(&tree.root),
        Err(MergeError::UnsafeHome)
    );
    fs::set_permissions(tree.cargo(), fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(tree.config(), fs::Permissions::from_mode(0o666)).unwrap();
    assert_eq!(
        merge_cargo_defaults(&tree.root),
        Err(MergeError::UnsafeConfig)
    );
    assert_eq!(fs::read_to_string(tree.config()).unwrap(), "");
    fs::set_permissions(tree.config(), fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(tree.config(), vec![b' '; 1_048_577]).unwrap();
    assert_eq!(
        merge_cargo_defaults(&tree.root),
        Err(MergeError::UnsafeConfig)
    );
    fs::write(tree.config(), [255]).unwrap();
    assert_eq!(
        merge_cargo_defaults(&tree.root),
        Err(MergeError::InvalidToml)
    );
    fs::remove_file(tree.config()).unwrap();
    fs::create_dir(tree.config()).unwrap();
    assert_eq!(
        merge_cargo_defaults(&tree.root),
        Err(MergeError::UnsafeConfig)
    );
}
#[test]
fn fifo_config_does_not_block() {
    let tree = Tree::new();
    fs::create_dir(tree.cargo()).unwrap();
    let mkfifo = std::env::var_os("REVERIE_TEST_MKFIFO").unwrap_or_else(|| "mkfifo".into());
    assert!(
        std::process::Command::new(mkfifo)
            .arg(tree.config())
            .status()
            .unwrap()
            .success()
    );
    assert_eq!(
        merge_cargo_defaults(&tree.root),
        Err(MergeError::UnsafeConfig)
    );
}
#[test]
fn replacement_content_change_new_config_or_new_legacy_config_refuses_publication() {
    for change in ["replacement", "content", "new", "legacy"] {
        let tree = Tree::new();
        if change != "new" {
            tree.write("# original\n");
        }
        let result = test_merge(&tree.root, || match change {
            "replacement" => {
                fs::remove_file(tree.config()).unwrap();
                fs::write(tree.config(), "# replacement\n").unwrap();
            }
            "content" => fs::write(tree.config(), "# changed\n").unwrap(),
            "new" => fs::write(tree.config(), "# created\n").unwrap(),
            _ => fs::write(tree.cargo().join("config"), "# legacy\n").unwrap(),
        });
        assert_eq!(result, Err(MergeError::Changed));
        assert!(
            !fs::read_to_string(tree.config())
                .unwrap()
                .contains("build-dir")
        );
        assert_eq!(tree.leftovers(), 0);
    }
}
#[test]
fn cargo_directory_replacement_refuses_and_cleans_only_the_original_owned_temporary() {
    let tree = Tree::new();
    tree.write("# original\n");
    let old = tree.root.join("old-cargo");
    assert_eq!(
        test_merge(&tree.root, || {
            fs::rename(tree.cargo(), &old).unwrap();
            fs::create_dir(tree.cargo()).unwrap();
            fs::write(tree.config(), "# new directory\n").unwrap();
        }),
        Err(MergeError::Changed)
    );
    assert_eq!(
        fs::read_to_string(tree.config()).unwrap(),
        "# new directory\n"
    );
    assert_eq!(fs::read_dir(&old).unwrap().count(), 1);
}
#[test]
fn cooperating_parallel_call_is_refused_without_changing_config() {
    let tree = Tree::new();
    tree.write("# owner\n");
    assert_eq!(
        test_merge(&tree.root, || assert_eq!(
            merge_cargo_defaults(&tree.root),
            Err(MergeError::Busy)
        )),
        Ok(MergeOutcome::Merged)
    );
    assert_eq!(tree.leftovers(), 0);
}

#[test]
fn prepared_source_swap_edit_hardlink_and_permission_drift_never_publish_foreign_bytes() {
    for change in ["swap", "edit", "link", "mode"] {
        let tree = Tree::new();
        tree.write("# owner original\n");
        let result = test_merge(&tree.root, || {
            let temporary = fs::read_dir(tree.cargo())
                .unwrap()
                .flatten()
                .find(|entry| entry.file_name().to_string_lossy().starts_with(".config-"))
                .unwrap()
                .path();
            match change {
                "swap" => {
                    fs::remove_file(&temporary).unwrap();
                    fs::write(&temporary, "# foreign replacement\n").unwrap();
                }
                "edit" => fs::write(&temporary, "# edited in place\n").unwrap(),
                "link" => fs::hard_link(&temporary, tree.root.join("alias")).unwrap(),
                _ => fs::set_permissions(&temporary, fs::Permissions::from_mode(0o666)).unwrap(),
            }
        });
        assert_eq!(result, Err(MergeError::Changed));
        assert_eq!(
            fs::read_to_string(tree.config()).unwrap(),
            "# owner original\n"
        );
        assert_eq!(tree.leftovers(), usize::from(change == "swap"));
    }
}
#[test]
fn home_or_cargo_becoming_group_writable_before_publication_is_refused() {
    for cargo in [false, true] {
        let tree = Tree::new();
        tree.write("# owner original\n");
        let path = if cargo {
            tree.cargo()
        } else {
            tree.root.clone()
        };
        assert_eq!(
            test_merge(&tree.root, || fs::set_permissions(
                &path,
                fs::Permissions::from_mode(0o775)
            )
            .unwrap()),
            Err(MergeError::Changed)
        );
        assert_eq!(
            fs::read_to_string(tree.config()).unwrap(),
            "# owner original\n"
        );
        assert_eq!(tree.leftovers(), 0);
    }
}
