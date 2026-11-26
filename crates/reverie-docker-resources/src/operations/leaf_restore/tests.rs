//! Real owned files/FDs exercise the write algorithm, not a fabricated cgroup grant.
//! Production still requires Scope::capture and CGROUP2_SUPER_MAGIC before Leaf exists.
use super::{Leaf, Policy, apply};
use crate::{
    args::{Arguments, Command, HighWrite},
    error::{Result, finalized},
    files::Files,
    scope,
};
use clap::Parser;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

fn argv(role: &str) -> Vec<String> {
    let mut values = vec!["helper".into(), role.into()];
    for (key, value) in [
        ("box-id", "a".repeat(64)),
        ("anchor-id", "b".repeat(64)),
        ("anchor-pid", "42".into()),
        ("anchor-start", "123".into()),
        ("worker-id", "c".repeat(64)),
        ("worker-pid", "43".into()),
        ("worker-start", "456".into()),
        ("member", format!("{}:44:789", "d".repeat(64))),
        ("leaf-dev", "1".into()),
        ("leaf-ino", "2".into()),
        ("memory-max", "51539607552".into()),
        ("swap-max", "0".into()),
        ("pids-max", "512".into()),
        ("memory-high", "51539607552".into()),
        ("cpu-weight", "100".into()),
    ] {
        values.extend([format!("--{key}"), value]);
    }
    values
}
fn input() -> HighWrite {
    match Arguments::try_parse_from(argv("restore-high"))
        .unwrap()
        .command
    {
        Command::RestoreHigh(input) => input,
        _ => panic!("distinct leaf restore role required"),
    }
}
/// A leaf as a reload of the service manager leaves it: the limits Docker
/// owns are kept, the ones only a helper wrote are back at their defaults.
struct Tree {
    path: PathBuf,
    files: Files,
    root: usize,
    written: Vec<String>,
    drift_after: Option<&'static str>,
}
impl Tree {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "reverie-restore-high-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        for (name, value) in [
            ("memory.max", "51539607552"),
            ("memory.high", "max"),
            ("memory.swap.max", "max"),
            ("pids.max", "512"),
            ("cpu.weight", "100"),
            ("cpu.max", "max 100000"),
            ("cpuset.cpus", "1-3"),
            ("cpuset.cpus.effective", "1-3"),
            ("cpuset.mems.effective", "0"),
        ] {
            fs::write(path.join(name), format!("{value}\n")).unwrap();
        }
        let mut files = Files::new();
        let root = files.storage(path.to_str().unwrap(), false).unwrap();
        Self {
            path,
            files,
            root,
            written: Vec::new(),
            drift_after: None,
        }
    }
    fn value(&self, name: &str) -> String {
        fs::read_to_string(self.path.join(name)).unwrap()
    }
}
impl Leaf for Tree {
    fn resources(&mut self) -> Result<crate::data::Resources> {
        scope::resources(&mut self.files, self.root)
    }
    fn write(&mut self, name: &str, value: &str) -> Result<()> {
        // Regular fixture files keep their tail; a kernel control file takes
        // each write as a replacement value. A symlink is left for the helper.
        let path = self.path.join(name);
        if fs::symlink_metadata(&path)?.file_type().is_file() {
            fs::write(&path, "")?;
        }
        self.files.write(self.root, name, &format!("{value}\n"))?;
        self.written.push(name.to_owned());
        if self.drift_after == Some(name) {
            // An independent actor changes a limit after an authorized write.
            fs::write(self.path.join("pids.max"), "max\n")?;
        }
        Ok(())
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        assert!(self.files.close_all().is_empty());
        fs::remove_dir_all(&self.path).unwrap();
    }
}

#[test]
fn restore_is_its_own_role_and_takes_the_bootstrap_arguments() {
    assert!(matches!(
        Arguments::try_parse_from(argv("configure-high"))
            .unwrap()
            .command,
        Command::ConfigureHigh(_)
    ));
    let mut args = argv("restore-high");
    args.extend(["--cpuset-cpus".into(), "0-3".into()]);
    assert!(Arguments::try_parse_from(args).is_err());
    assert_eq!(input().worker.common.member.len(), 1);
}
#[test]
fn a_reloaded_leaf_gets_exactly_the_three_helper_owned_limits_back() {
    let input = input();
    let policy = Policy::new(&input).unwrap();
    let mut tree = Tree::new();
    apply(&mut tree, &policy).unwrap();
    assert_eq!(
        tree.written,
        ["memory.swap.max", "memory.high", "cpu.weight"]
    );
    assert!(tree.files.issued);
    assert_eq!(tree.value("memory.swap.max"), "0\n");
    assert_eq!(tree.value("memory.high"), "51539607552\n");
    assert_eq!(tree.value("cpu.weight"), "100\n");
    for (name, kept) in [
        ("memory.max", "51539607552\n"),
        ("pids.max", "512\n"),
        ("cpu.max", "max 100000\n"),
        ("cpuset.cpus", "1-3\n"),
    ] {
        assert_eq!(tree.value(name), kept, "{name}");
    }
}
#[test]
fn a_limit_the_engine_owns_is_never_written_and_refuses_before_any_write() {
    for (name, changed) in [("memory.max", "max\n"), ("pids.max", "513\n")] {
        let input = input();
        let policy = Policy::new(&input).unwrap();
        let mut tree = Tree::new();
        fs::write(tree.path.join(name), changed).unwrap();
        assert!(apply(&mut tree, &policy).is_err(), "{name}");
        assert!(!tree.files.issued, "{name}");
        assert!(tree.written.is_empty(), "{name}");
        assert_eq!(tree.value(name), changed, "{name}");
        assert_eq!(tree.value("memory.swap.max"), "max\n", "{name}");
        assert_eq!(tree.value("memory.high"), "max\n", "{name}");
    }
}
#[test]
fn drift_after_a_write_is_preserved_and_cannot_acknowledge_success() {
    let input = input();
    let policy = Policy::new(&input).unwrap();
    let mut tree = Tree::new();
    tree.drift_after = Some("memory.high");
    let result = apply(&mut tree, &policy);
    assert!(result.is_err());
    assert!(tree.files.issued);
    assert_eq!(tree.value("pids.max"), "max\n");
    assert!(finalized(result, tree.files.close_all()).is_err());
}
#[test]
fn a_symlinked_control_file_cannot_redirect_a_write() {
    let input = input();
    let policy = Policy::new(&input).unwrap();
    let mut tree = Tree::new();
    fs::remove_file(tree.path.join("memory.swap.max")).unwrap();
    symlink("pids.max", tree.path.join("memory.swap.max")).unwrap();
    assert!(apply(&mut tree, &policy).is_err());
    assert!(!tree.files.issued);
    assert!(tree.written.is_empty());
    assert_eq!(tree.value("pids.max"), "512\n");
}
#[test]
fn a_policy_without_births_or_within_no_hard_limit_is_refused_before_effects() {
    let mut input = input();
    input.memory_high = input.memory_max + 1;
    assert!(Policy::new(&input).is_err());
    input.memory_high = input.memory_max;
    input.cpu_weight = 10001;
    assert!(Policy::new(&input).is_err());
    input.cpu_weight = 100;
    input.worker.worker_start = None;
    assert!(Policy::new(&input).is_err());
    input.worker.worker_start = Some(456);
    input.worker.common.anchor_start = Some(0);
    assert!(Policy::new(&input).is_err());
}
#[test]
fn successful_restore_cannot_acknowledge_a_lost_consuming_close() {
    let input = input();
    let policy = Policy::new(&input).unwrap();
    let mut tree = Tree::new();
    let result = apply(&mut tree, &policy);
    assert!(result.is_ok());
    tree.files.lose_next_close_ack();
    let result = finalized(result, tree.files.close_all());
    assert!(matches!(
        result,
        Err(crate::error::Error::Finalization { primary: None, .. })
    ));
    assert!(tree.files.close_all().is_empty());
}
