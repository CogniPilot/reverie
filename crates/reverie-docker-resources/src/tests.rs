use crate::{
    args::{self, Arguments},
    data,
    error::{Error, finalized},
    files::Files,
};
use clap::Parser;
use std::{
    fs,
    os::unix::fs::{MetadataExt, symlink},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "reverie-docker-resources-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self) -> &str {
        self.0.to_str().unwrap()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn canonical_inputs_refuse_ambiguous_or_truncated_identity() {
    for raw in ["", "01", "+1", " 1", "1\n", "18446744073709551616"] {
        assert!(args::decimal(raw).is_err(), "{raw:?}");
    }
    assert_eq!(args::decimal("18446744073709551615").unwrap(), u64::MAX);
    assert!(args::hex(&"a".repeat(64)).is_ok());
    for raw in [
        "a".repeat(63),
        "A".repeat(64),
        format!("{}g", "a".repeat(63)),
    ] {
        assert!(args::hex(&raw).is_err());
    }
}
#[test]
fn cli_has_only_fixed_roles_and_requires_actual_resource_target() {
    assert!(Arguments::try_parse_from(["helper", "configure-high"]).is_err());
    assert!(Arguments::try_parse_from(["helper", "exec", "/bin/sh"]).is_err());
    assert!(Arguments::try_parse_from(["helper", "probe-storage", "--path", "/etc"]).is_err());
    assert!(
        Arguments::try_parse_from(["helper", "storage-status", "--holder-start", "01"]).is_err()
    );
    assert!(
        Arguments::try_parse_from([
            "helper",
            "probe-pool",
            "--box-id",
            &"a".repeat(64),
            "--anchor-id",
            &"b".repeat(64),
            "--anchor-pid",
            "1"
        ])
        .is_err()
    );
}
#[test]
fn kernel_values_are_bounded_and_canonical() {
    for value in ["max\n", "0\n", "17179869184\n"] {
        assert!(data::scalar(value).is_ok());
    }
    for value in ["max\n\n", "00", "-1", "max garbage"] {
        assert!(data::scalar(value).is_err());
    }
    assert_eq!(data::cpu_max("max 100000\n").unwrap(), "max 100000");
    for value in ["max 0", "0 100", "1  100", "1 0100"] {
        assert!(data::cpu_max(value).is_err());
    }
    assert_eq!(data::cpus("0-3,8").unwrap().len(), 5);
    for value in ["0-3,2", "3-1", "0-8192", "00", "1,,2"] {
        assert!(data::cpus(value).is_err());
    }
}
#[test]
fn cpu_sets_are_kernel_canonical_before_any_write() {
    assert_eq!(data::canonical_cpus("0,1").unwrap(), "0-1");
    assert_eq!(data::canonical_cpus("8,0,1,4-6").unwrap(), "0-1,4-6,8");
    assert_eq!(data::canonical_cpus("31").unwrap(), "31");
    assert_eq!(data::canonical_cpus("").unwrap(), "");
    for value in ["0,0", "0-1,1", "8192", "01"] {
        assert!(data::canonical_cpus(value).is_err());
    }
}
#[test]
fn stat_uses_pinned_pid_birth_and_refuses_dead_or_malformed_process() {
    let fields = std::iter::once("S")
        .chain(std::iter::repeat_n("0", 18))
        .chain(["1234", "0"])
        .collect::<Vec<_>>()
        .join(" ");
    let raw = format!("42 (name ) with spaces) {fields}\n");
    assert_eq!(data::process_stat(&raw, 42).unwrap(), 1234);
    assert!(data::process_stat(&raw, 43).is_err());
    assert!(data::process_stat(&raw.replace(") S ", ") Z "), 42).is_err());
    assert!(data::process_stat("42 (broken) S 0", 42).is_err());
}
#[test]
fn root_and_component_symlinks_are_refused() {
    let tree = Tree::new();
    let real = tree.0.join("real");
    fs::create_dir(&real).unwrap();
    symlink(&real, tree.0.join("alias")).unwrap();
    let mut files = Files::new();
    assert!(
        files
            .storage(tree.0.join("alias").to_str().unwrap(), false)
            .is_err()
    );
    let root = files.storage(tree.path(), false).unwrap();
    let magic = nix::sys::statfs::fstatfs(files.get(root))
        .unwrap()
        .filesystem_type();
    assert!(files.child(root, "alias", magic).is_err());
    for component in ["../real", ".", "..", ""] {
        assert!(files.child(root, component, magic).is_err());
    }
    assert!(files.close_all().is_empty());
}
#[test]
fn retained_directory_survives_named_replacement_without_adopting_new_inode() {
    let tree = Tree::new();
    let path = tree.0.join("home");
    fs::create_dir(&path).unwrap();
    let mut files = Files::new();
    let index = files.storage(path.to_str().unwrap(), false).unwrap();
    let original = files.identity(index).unwrap();
    fs::rename(&path, tree.0.join("old")).unwrap();
    fs::create_dir(&path).unwrap();
    assert_eq!(files.identity(index).unwrap(), original);
    let current = fs::metadata(&path).unwrap();
    assert_ne!((current.dev(), current.ino()), original);
    assert!(files.close_all().is_empty());
    assert!(files.close_all().is_empty());
}
#[test]
fn bounded_reads_refuse_symlinks_and_preserve_original_parent_custody() {
    let tree = Tree::new();
    fs::write(tree.0.join("value"), "12345").unwrap();
    symlink("value", tree.0.join("alias")).unwrap();
    let mut files = Files::new();
    let root = files.storage(tree.path(), false).unwrap();
    assert!(files.read(root, "alias", 10).is_err());
    assert!(files.read(root, "value", 4).is_err());
    assert_eq!(files.read(root, "value", 5).unwrap(), "12345");
    assert!(files.close_all().is_empty());
}
#[test]
fn failed_validation_and_consuming_close_are_both_preserved() {
    let result: crate::error::Result<()> = finalized(
        Err(Error::Refused("original")),
        vec![std::io::Error::from_raw_os_error(nix::libc::EINTR)],
    );
    let error = result.unwrap_err();
    let Error::Finalization { primary, close } = error else {
        panic!("aggregate required")
    };
    assert!(matches!(
        primary.as_deref(),
        Some(Error::Refused("original"))
    ));
    assert_eq!(close[0].raw_os_error(), Some(nix::libc::EINTR));
}
#[test]
fn directory_enumeration_uses_fresh_owned_cursor_and_never_adopts_symlinks() {
    let tree = Tree::new();
    fs::create_dir(tree.0.join("child")).unwrap();
    fs::write(tree.0.join("scalar"), "value").unwrap();
    let mut files = Files::new();
    let root = files.storage(tree.path(), false).unwrap();
    let identity = files.identity(root).unwrap();
    for _ in 0..4 {
        assert_eq!(files.entries(root).unwrap(), ["child"]);
    }
    assert_eq!(files.identity(root).unwrap(), identity);
    symlink("child", tree.0.join("alias")).unwrap();
    assert!(files.entries(root).is_err());
    assert!(files.close_all().is_empty());
}
#[test]
fn enumeration_with_real_cursor_close_but_lost_ack_refuses_success_once() {
    let tree = Tree::new();
    let mut files = Files::new();
    let root = files.storage(tree.path(), false).unwrap();
    files.lose_next_close_ack();
    let error = files.entries(root).unwrap_err();
    let Error::Finalization { primary, close } = error else {
        panic!("close owner required")
    };
    assert!(primary.is_none());
    assert_eq!(close.len(), 1);
    assert_eq!(close[0].raw_os_error(), Some(nix::libc::EINTR));
    assert!(files.get(root).metadata().is_ok());
    assert!(files.close_all().is_empty());
    assert!(files.close_all().is_empty());
}
