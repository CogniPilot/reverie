//! Real owned files/FDs exercise the write algorithm, not a fabricated cgroup grant.
//! Production still requires Scope::capture and CGROUP2_SUPER_MAGIC before Leaf exists.
use super::{Leaf, Policy, apply};
use crate::{
    args::{Arguments, Command, MemoryHighWrite},
    error::{Result, finalized},
    files::Files,
    scope,
};
use clap::Parser;
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

fn argv() -> Vec<String> {
    let mut values = vec!["helper".into(), "configure-memory-high".into()];
    for (key, value) in [
        ("box-id", "a".repeat(64)),
        ("anchor-id", "b".repeat(64)),
        ("anchor-pid", "42".into()),
        ("anchor-start", "123".into()),
        ("worker-id", "c".repeat(64)),
        ("worker-pid", "43".into()),
        ("worker-start", "456".into()),
        ("leaf-dev", "1".into()),
        ("leaf-ino", "2".into()),
        ("memory-max", (48_u64 * 1024_u64.pow(3)).to_string()),
        ("swap-max", "0".into()),
        ("pids-max", "512".into()),
        ("memory-high", (48_u64 * 1024_u64.pow(3)).to_string()),
        ("cpu-weight", "100".into()),
        ("cpuset-cpus", "0-3".into()),
    ] {
        values.extend([format!("--{key}"), value]);
    }
    values
}
fn input() -> MemoryHighWrite {
    match Arguments::try_parse_from(argv()).unwrap().command {
        Command::ConfigureMemoryHigh(input) => input,
        _ => panic!("memory-only role required"),
    }
}
struct Tree {
    path: PathBuf,
    files: Files,
    root: usize,
    writes: usize,
    drift_after_write: bool,
}
impl Tree {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "reverie-high-only-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        for (name, value) in [
            ("memory.max", "51539607552"),
            ("memory.high", "17179869184"),
            ("memory.swap.max", "0"),
            ("pids.max", "512"),
            ("cpu.weight", "100"),
            ("cpu.max", "max 100000"),
            ("cpuset.cpus", "0-3"),
            ("cpuset.cpus.effective", "0-3"),
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
            writes: 0,
            drift_after_write: false,
        }
    }
    fn other_files(&self) -> BTreeMap<String, (Vec<u8>, u64, i64, i64)> {
        fs::read_dir(&self.path)
            .unwrap()
            .map(|entry| entry.unwrap())
            .filter(|entry| entry.file_name() != "memory.high")
            .map(|entry| {
                let stat = entry.metadata().unwrap();
                (
                    entry.file_name().into_string().unwrap(),
                    (
                        fs::read(entry.path()).unwrap(),
                        stat.ino(),
                        stat.mtime(),
                        stat.mtime_nsec(),
                    ),
                )
            })
            .collect()
    }
}
impl Leaf for Tree {
    fn resources(&mut self) -> Result<crate::data::Resources> {
        scope::resources(&mut self.files, self.root)
    }
    fn write_memory_high(&mut self, value: &str) -> Result<()> {
        self.files
            .write(self.root, "memory.high", &format!("{value}\n"))?;
        self.writes += 1;
        if self.drift_after_write {
            // An independent actor changes CPU policy after the authorized high write.
            fs::write(self.path.join("cpu.weight"), "217\n")?;
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
fn fixed_role_requires_cpu_set_and_leaves_bootstrap_parser_unchanged() {
    let mut args = argv();
    args.truncate(args.len() - 2);
    assert!(Arguments::try_parse_from(&args).is_err());
    args[1] = "configure-high".into();
    assert!(matches!(
        Arguments::try_parse_from(args).unwrap().command,
        Command::ConfigureHigh(_)
    ));
}
#[test]
fn only_memory_high_changes_in_actual_owned_files() {
    let input = input();
    let policy = Policy::new(&input).unwrap();
    let mut tree = Tree::new();
    let before = tree.other_files();
    apply(&mut tree, &policy).unwrap();
    assert_eq!(tree.writes, 1);
    assert!(tree.files.issued);
    assert_eq!(
        fs::read_to_string(tree.path.join("memory.high")).unwrap(),
        "51539607552\n"
    );
    assert_eq!(tree.other_files(), before);
}
#[test]
fn every_changed_other_limit_refuses_before_any_write() {
    for (name, changed) in [
        ("memory.max", "68719476736\n"),
        ("memory.swap.max", "4096\n"),
        ("pids.max", "513\n"),
        ("cpu.weight", "217\n"),
        ("cpu.max", "1000 100000\n"),
        ("cpuset.cpus", "0-2\n"),
        ("cpuset.cpus.effective", "0-2\n"),
    ] {
        let input = input();
        let policy = Policy::new(&input).unwrap();
        let mut tree = Tree::new();
        fs::write(tree.path.join(name), changed).unwrap();
        let before = tree.other_files();
        assert!(apply(&mut tree, &policy).is_err(), "{name}");
        assert!(!tree.files.issued, "{name}");
        assert_eq!(tree.writes, 0, "{name}");
        assert_eq!(tree.other_files(), before, "{name}");
        assert_eq!(
            fs::read_to_string(tree.path.join("memory.high")).unwrap(),
            "17179869184\n"
        );
    }
}
#[test]
fn cpu_drift_after_high_write_is_preserved_and_cannot_acknowledge_success() {
    let input = input();
    let policy = Policy::new(&input).unwrap();
    let mut tree = Tree::new();
    tree.drift_after_write = true;
    let result = apply(&mut tree, &policy);
    assert!(result.is_err());
    assert!(tree.files.issued);
    assert_eq!(tree.writes, 1);
    assert_eq!(
        fs::read_to_string(tree.path.join("cpu.weight")).unwrap(),
        "217\n"
    );
    assert!(finalized(result, tree.files.close_all()).is_err());
}
#[test]
fn a_memory_high_symlink_cannot_redirect_the_only_write() {
    let input = input();
    let policy = Policy::new(&input).unwrap();
    let mut tree = Tree::new();
    fs::remove_file(tree.path.join("memory.high")).unwrap();
    symlink("cpu.weight", tree.path.join("memory.high")).unwrap();
    assert!(apply(&mut tree, &policy).is_err());
    assert!(!tree.files.issued);
    assert_eq!(tree.writes, 0);
    assert_eq!(
        fs::read_to_string(tree.path.join("cpu.weight")).unwrap(),
        "100\n"
    );
}
#[test]
fn ambiguous_or_unaligned_policy_is_refused_before_effects() {
    let mut input = input();
    input.high.memory_high += 1;
    assert!(Policy::new(&input).is_err());
    input.high.memory_high -= 1;
    for raw in ["", "0,0", "8192"] {
        input.cpuset_cpus = raw.into();
        assert!(Policy::new(&input).is_err());
    }
}

#[test]
fn successful_write_cannot_acknowledge_a_lost_consuming_close() {
    let input = input();
    let policy = Policy::new(&input).unwrap();
    let mut tree = Tree::new();
    let result = apply(&mut tree, &policy);
    assert!(result.is_ok());
    assert!(tree.files.issued);
    tree.files.lose_next_close_ack();
    let result = finalized(result, tree.files.close_all());
    assert!(matches!(
        result,
        Err(crate::error::Error::Finalization { primary: None, .. })
    ));
    assert!(tree.files.close_all().is_empty());
}
