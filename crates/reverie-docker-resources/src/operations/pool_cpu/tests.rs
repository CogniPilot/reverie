//! Real owned files/FDs exercise the write algorithm, not a fabricated cgroup grant.
//! Production still requires Scope::capture and CGROUP2_SUPER_MAGIC before Ceiling exists.
use super::{Ceiling, Policy, apply};
use crate::{
    args::{Arguments, Command, CpuCeiling, PoolCpuMaxWrite},
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

fn argv(cores: &str) -> Vec<String> {
    let mut values = vec!["helper".into(), "configure-pool-cpu-max".into()];
    for (key, value) in [
        ("box-id", "a".repeat(64)),
        ("anchor-id", "b".repeat(64)),
        ("anchor-pid", "42".into()),
        ("anchor-start", "123".into()),
        ("member", format!("{}:43:456", "c".repeat(64))),
        ("member", format!("{}:44:789", "d".repeat(64))),
        ("parent-dev", "1".into()),
        ("parent-ino", "2".into()),
        ("memory-max", "51539607552".into()),
        ("swap-max", "0".into()),
        ("pids-max", "8192".into()),
        ("cpu-weight", "100".into()),
        ("cpuset-cpus", "0-31".into()),
        ("cpu-max-cores", cores.into()),
    ] {
        values.extend([format!("--{key}"), value]);
    }
    values
}
fn input(cores: &str) -> PoolCpuMaxWrite {
    match Arguments::try_parse_from(argv(cores)).unwrap().command {
        Command::ConfigurePoolCpuMax(input) => input,
        _ => panic!("ceiling-only role required"),
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
            "reverie-pool-cpu-max-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        for (name, value) in [
            ("memory.max", "51539607552"),
            ("memory.high", "max"),
            ("memory.swap.max", "0"),
            ("pids.max", "8192"),
            ("cpu.weight", "100"),
            ("cpu.max", "max 100000"),
            ("cpuset.cpus", "0-31"),
            ("cpuset.cpus.effective", "0-31"),
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
            .filter(|entry| entry.file_name() != "cpu.max")
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
    fn cpu_max(&self) -> String {
        fs::read_to_string(self.path.join("cpu.max")).unwrap()
    }
}
impl Ceiling for Tree {
    fn resources(&mut self) -> Result<crate::data::Resources> {
        scope::resources(&mut self.files, self.root)
    }
    fn write_cpu_max(&mut self, value: &str) -> Result<()> {
        // A kernel control file replaces its value; a regular fixture file
        // keeps its tail. Only the real file is emptied, never a link target.
        let target = self.path.join("cpu.max");
        if fs::symlink_metadata(&target)?.is_file() {
            fs::write(&target, "")?;
        }
        self.files
            .write(self.root, "cpu.max", &format!("{value}\n"))?;
        self.writes += 1;
        if self.drift_after_write {
            // An independent actor changes memory policy after the authorized write.
            fs::write(self.path.join("memory.max"), "68719476736\n")?;
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
fn only_cpu_max_changes_in_actual_owned_files() {
    let input = input("24");
    let policy = Policy::new(&input).unwrap();
    let mut tree = Tree::new();
    let before = tree.other_files();
    apply(&mut tree, &policy).unwrap();
    assert_eq!(tree.writes, 1);
    assert!(tree.files.issued);
    assert_eq!(tree.cpu_max(), "2400000 100000\n");
    assert_eq!(tree.other_files(), before);
}
#[test]
fn max_removes_an_existing_ceiling_and_a_new_count_replaces_it() {
    let mut tree = Tree::new();
    for (cores, expected) in [
        ("24", "2400000 100000\n"),
        ("16", "1600000 100000\n"),
        ("max", "max 100000\n"),
        ("32", "3200000 100000\n"),
    ] {
        let input = input(cores);
        apply(&mut tree, &Policy::new(&input).unwrap()).unwrap();
        assert_eq!(tree.cpu_max(), expected, "{cores}");
    }
    assert_eq!(tree.writes, 4);
}
#[test]
fn every_changed_other_limit_refuses_before_any_write() {
    for (name, changed) in [
        ("memory.max", "68719476736\n"),
        ("memory.high", "17179869184\n"),
        ("memory.swap.max", "4096\n"),
        ("pids.max", "8193\n"),
        ("cpu.weight", "217\n"),
        ("cpuset.cpus", "0-30\n"),
        ("cpuset.cpus.effective", "0-30\n"),
    ] {
        let input = input("24");
        let policy = Policy::new(&input).unwrap();
        let mut tree = Tree::new();
        fs::write(tree.path.join(name), changed).unwrap();
        let before = tree.other_files();
        assert!(apply(&mut tree, &policy).is_err(), "{name}");
        assert!(!tree.files.issued, "{name}");
        assert_eq!(tree.writes, 0, "{name}");
        assert_eq!(tree.other_files(), before, "{name}");
        assert_eq!(tree.cpu_max(), "max 100000\n");
    }
}
#[test]
fn other_limit_drift_after_the_write_is_preserved_and_cannot_acknowledge_success() {
    let input = input("24");
    let policy = Policy::new(&input).unwrap();
    let mut tree = Tree::new();
    tree.drift_after_write = true;
    let result = apply(&mut tree, &policy);
    assert!(result.is_err());
    assert!(tree.files.issued);
    assert_eq!(tree.writes, 1);
    assert_eq!(
        fs::read_to_string(tree.path.join("memory.max")).unwrap(),
        "68719476736\n"
    );
    assert!(finalized(result, tree.files.close_all()).is_err());
}
#[test]
fn a_cpu_max_symlink_cannot_redirect_the_only_write() {
    let input = input("24");
    let policy = Policy::new(&input).unwrap();
    let mut tree = Tree::new();
    fs::remove_file(tree.path.join("cpu.max")).unwrap();
    symlink("cpu.weight", tree.path.join("cpu.max")).unwrap();
    assert!(apply(&mut tree, &policy).is_err());
    assert!(!tree.files.issued);
    assert_eq!(tree.writes, 0);
    assert_eq!(
        fs::read_to_string(tree.path.join("cpu.weight")).unwrap(),
        "100\n"
    );
}
#[test]
fn ambiguous_or_unavailable_ceiling_is_refused_before_effects() {
    for raw in [
        "",
        "0",
        "01",
        "+24",
        "24.5",
        "2400000 100000",
        "8193",
        "MAX",
    ] {
        assert!(Arguments::try_parse_from(argv(raw)).is_err(), "{raw:?}");
    }
    assert_eq!(input("max").cpu_max_cores, CpuCeiling::Unlimited);
    assert_eq!(input("1").cpu_max_cores, CpuCeiling::Cores(1));
    assert!(Policy::new(&input("32")).is_ok());
    // More CPUs than the pool's own CPU set would limit nothing.
    assert!(Policy::new(&input("33")).is_err());
    let mut narrowed = input("24");
    narrowed.pool.cpuset_cpus = Some("0-7".into());
    assert!(Policy::new(&narrowed).is_err());
    for raw in ["", "0,0", "8192"] {
        let mut input = input("1");
        input.pool.cpuset_cpus = Some(raw.into());
        assert!(Policy::new(&input).is_err(), "{raw:?}");
    }
}
#[test]
fn fixed_role_requires_cpu_set_births_and_unique_members() {
    let mut args = argv("24");
    args.truncate(args.len() - 2);
    assert!(Arguments::try_parse_from(&args).is_err());
    let mut missing_set = input("24");
    missing_set.pool.cpuset_cpus = None;
    assert!(Policy::new(&missing_set).is_err());
    let mut unborn_anchor = input("24");
    unborn_anchor.pool.common.anchor_start = None;
    assert!(Policy::new(&unborn_anchor).is_err());
    let mut unborn_member = input("24");
    unborn_member.pool.common.member[0].start = 0;
    assert!(Policy::new(&unborn_member).is_err());
    let mut repeated = input("24");
    repeated
        .pool
        .common
        .member
        .push(repeated.pool.common.member[0].clone());
    assert!(Policy::new(&repeated).is_err());
    // An empty pool may receive its ceiling before the first member starts.
    let mut empty = input("24");
    empty.pool.common.member.clear();
    assert!(Policy::new(&empty).is_ok());
}
#[test]
fn ceiling_role_never_reaches_native_files_without_a_valid_policy() {
    let mut input = input("24");
    input.pool.common.member[0].start = 0;
    let mut files = Files::new();
    assert!(
        crate::operations::configure_pool_cpu_max(&mut files, &input)
            .unwrap_err()
            .to_string()
            .contains("BOXED_RESOURCE_PID_BIRTH_REQUIRED")
    );
    assert!(!files.issued);
    assert!(files.close_all().is_empty());
}
#[test]
fn successful_write_cannot_acknowledge_a_lost_consuming_close() {
    let input = input("24");
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
