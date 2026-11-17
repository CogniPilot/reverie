//! Owned regular files exercise the shared write algorithm, not native cgroup authority.
use super::{Policy, Pool, apply, require_restore_members};
use crate::{
    args::{Arguments, Command, PoolWrite},
    error::{Result, finalized, need},
    files::Files,
    scope,
};
use clap::Parser;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

fn input() -> PoolWrite {
    let mut args = vec!["helper".to_owned(), "restore-pool".to_owned()];
    for (key, value) in [
        ("box-id", "a".repeat(64)),
        ("anchor-id", "b".repeat(64)),
        ("anchor-pid", "42".into()),
        ("anchor-start", "123".into()),
        ("member", format!("{}:43:456", "c".repeat(64))),
        ("parent-dev", "1".into()),
        ("parent-ino", "2".into()),
        ("memory-max", "51539607552".into()),
        ("swap-max", "0".into()),
        ("pids-max", "8192".into()),
        ("cpu-weight", "100".into()),
        ("cpuset-cpus", "0-3".into()),
    ] {
        args.extend([format!("--{key}"), value]);
    }
    match Arguments::try_parse_from(args).unwrap().command {
        Command::RestorePool(input) => input,
        _ => panic!("distinct restore role required"),
    }
}
struct Tree {
    path: PathBuf,
    files: Files,
    root: usize,
    writes: usize,
    current: bool,
    lose_after: Option<usize>,
}
impl Tree {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "reverie-restore-pool-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        for (name, value) in [
            ("memory.max", "max"),
            ("memory.high", "max"),
            ("memory.swap.max", "max"),
            ("pids.max", "max"),
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
            current: true,
            lose_after: None,
        }
    }
}
impl Pool for Tree {
    fn resources(&mut self) -> Result<crate::data::Resources> {
        need(self.current, "TEST_SCOPE_CHANGED")?;
        scope::resources(&mut self.files, self.root)
    }
    fn write(&mut self, name: &str, value: &str) -> Result<()> {
        need(self.current, "TEST_SCOPE_CHANGED")?;
        // Regular fixture files have persistent offsets/tails; kernel control
        // files consume each write as a replacement value.
        fs::write(self.path.join(name), "")?;
        self.files.write(self.root, name, &format!("{value}\n"))?;
        need(
            self.files
                .read(self.root, name, 4096)?
                .trim_end_matches('\n')
                == value,
            "BOXED_RESOURCE_WRITE_READBACK",
        )?;
        self.writes += 1;
        if self.lose_after == Some(self.writes) {
            self.current = false;
        }
        need(self.current, "TEST_SCOPE_CHANGED")
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        assert!(self.files.close_all().is_empty());
        fs::remove_dir_all(&self.path).unwrap();
    }
}
#[test]
fn restore_requires_complete_explicit_birth_bound_unique_members() {
    let mut input = input();
    require_restore_members(&input.common).unwrap();
    input.common.member[0].start = 0;
    assert!(require_restore_members(&input.common).is_err());
    input.common.member[0].start = 456;
    input.common.member.push(input.common.member[0].clone());
    assert!(require_restore_members(&input.common).is_err());
    input.common.member.clear();
    assert!(require_restore_members(&input.common).is_err());
}
#[test]
fn initialization_still_refuses_populated_pool_before_opening_native_files() {
    let input = input();
    let mut files = Files::new();
    assert!(
        crate::operations::configure_pool(&mut files, &input)
            .unwrap_err()
            .to_string()
            .contains("BOXED_RESOURCE_POOL_INITIALIZATION_ONLY")
    );
    assert!(!files.issued);
    assert!(files.close_all().is_empty());
}
#[test]
fn actual_owned_pool_files_receive_full_declared_policy() {
    let input = input();
    let policy = Policy::new(&input).unwrap();
    let mut tree = Tree::new();
    apply(&mut tree, &policy).unwrap();
    assert_eq!(tree.writes, 6);
    assert!(tree.files.issued);
    policy.require_final(&tree.resources().unwrap()).unwrap();
    assert_eq!(
        fs::read_to_string(tree.path.join("cpu.max")).unwrap(),
        "max 100000\n"
    );
}
#[test]
fn lost_scope_at_every_write_never_acknowledges_or_continues() {
    for ordinal in 1..=6 {
        let input = input();
        let policy = Policy::new(&input).unwrap();
        let mut tree = Tree::new();
        tree.lose_after = Some(ordinal);
        assert!(apply(&mut tree, &policy).is_err());
        assert_eq!(tree.writes, ordinal);
    }
    let input = input();
    let policy = Policy::new(&input).unwrap();
    let mut tree = Tree::new();
    tree.current = false;
    assert!(apply(&mut tree, &policy).is_err());
    assert_eq!(tree.writes, 0);
    assert!(!tree.files.issued);
}
#[test]
fn unavailable_cpu_policy_refuses_before_any_write() {
    let mut input = input();
    input.cpuset_cpus = Some("0-4".into());
    let policy = Policy::new(&input).unwrap();
    let mut tree = Tree::new();
    assert!(apply(&mut tree, &policy).is_err());
    assert_eq!(tree.writes, 0);
}
#[test]
fn consuming_close_loss_cannot_acknowledge_successful_pool_writes() {
    let input = input();
    let policy = Policy::new(&input).unwrap();
    let mut tree = Tree::new();
    let result = apply(&mut tree, &policy);
    assert!(result.is_ok());
    tree.files.lose_next_close_ack();
    assert!(finalized(result, tree.files.close_all()).is_err());
}
