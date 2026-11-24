//! Owned directories stand in for the box cgroup and the process filesystem,
//! so the capture and currency checks themselves run. They earn no native
//! scope: only `Scope::capture` binds the kernel's own views, as root.
use super::{Scope, Views, census::departed};
use crate::{
    args::{Common, Member},
    error::{Error, Result, finalized},
    files::Files,
};
use nix::{libc, sys::statfs};
use std::{
    cell::Cell,
    fs, io,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

const ANCHOR: (u32, u64) = (42, 123);
const WORKER: (u32, u64) = (43, 456);
const MEMBER: (u32, u64) = (44, 789);
/// A second task of the plain member: the one that comes and goes.
const TASK: u32 = 77;

fn id(letter: char) -> String {
    letter.to_string().repeat(64)
}
fn scope_path(container: &str) -> String {
    format!(
        "/reverie.slice/reverie-box.slice/reverie-box-{}.slice/docker-{container}.scope",
        id('a')
    )
}
fn common() -> Common {
    Common {
        box_id: id('a'),
        anchor_id: id('b'),
        anchor_pid: ANCHOR.0,
        anchor_start: Some(ANCHOR.1),
        member: vec![
            Member {
                id: id('c'),
                pid: WORKER.0,
                start: WORKER.1,
            },
            Member {
                id: id('d'),
                pid: MEMBER.0,
                start: MEMBER.1,
            },
        ],
    }
}
fn list(path: &Path, tasks: &[u32]) {
    let lines = tasks.iter().map(|task| format!("{task}\n"));
    fs::write(path, lines.collect::<String>()).unwrap();
}
fn record(directory: &Path, container: &str, task: u32, state: &str, start: u64) {
    let fields = std::iter::once(state.to_owned())
        .chain(std::iter::repeat_n("0".to_owned(), 18))
        .chain([start.to_string(), "0".to_owned()])
        .collect::<Vec<_>>()
        .join(" ");
    fs::create_dir_all(directory).unwrap();
    fs::write(
        directory.join("cgroup"),
        format!("0::{}\n", scope_path(container)),
    )
    .unwrap();
    fs::write(
        directory.join("stat"),
        format!("{task} (busy loop) {fields}\n"),
    )
    .unwrap();
}

struct Tree {
    root: PathBuf,
    files: Files,
    parent: usize,
    tasks: usize,
}
impl Tree {
    /// A box holding the anchor, the worker, and a member with a second task.
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "reverie-scope-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("proc")).unwrap();
        fs::create_dir(root.join("box")).unwrap();
        fs::write(root.join("box/cgroup.type"), "domain\n").unwrap();
        fs::write(root.join("box/cgroup.procs"), "").unwrap();
        let mut files = Files::new();
        let tasks = files
            .storage(root.join("proc").to_str().unwrap(), false)
            .unwrap();
        let parent = files
            .storage(root.join("box").to_str().unwrap(), false)
            .unwrap();
        let tree = Self {
            root,
            files,
            parent,
            tasks,
        };
        tree.container(&id('b'), ANCHOR, &[]);
        tree.container(&id('c'), WORKER, &[]);
        tree.container(&id('d'), MEMBER, &[TASK]);
        tree
    }
    fn container(&self, container: &str, init: (u32, u64), others: &[u32]) {
        let cgroup = self.cgroup(container);
        fs::create_dir(&cgroup).unwrap();
        fs::write(cgroup.join("cgroup.type"), "domain\n").unwrap();
        list(&cgroup.join("cgroup.procs"), &[init.0]);
        let tasks = [&[init.0], others].concat();
        list(&cgroup.join("cgroup.threads"), &tasks);
        for task in tasks {
            record(&self.task(task), container, task, "S", init.1);
        }
    }
    fn cgroup(&self, container: &str) -> PathBuf {
        self.root.join(format!("box/docker-{container}.scope"))
    }
    fn task(&self, task: u32) -> PathBuf {
        self.root.join(format!("proc/{task}"))
    }
    fn text(&self, relative: &str) -> String {
        self.root.join(relative).to_str().unwrap().to_owned()
    }
    fn bind(&mut self) -> Result<Scope> {
        let magic = statfs::fstatfs(self.files.get(self.parent))
            .unwrap()
            .filesystem_type();
        let views = Views {
            cgroup_magic: magic,
            tasks: self.tasks,
            tasks_magic: magic,
        };
        let worker = id('c');
        Scope::bind(
            &mut self.files,
            &common(),
            Some(&worker),
            self.parent,
            views,
        )
    }
    /// Runs `seen` on every open below the tree, by its path inside the tree.
    fn intercept(&mut self, mut seen: impl FnMut(&str) -> Option<io::Error> + 'static) {
        let prefix = self.text("");
        self.files.intercept_with(Box::new(move |path| {
            seen(path.strip_prefix(&prefix).expect("owned path"))
        }));
    }
    /// The plain member's second task ends when `at` is about to be opened,
    /// and the cgroup stops listing it from its `relisting`-th later listing.
    fn end_task(&mut self, at: &'static str, relisting: u32) -> Rc<Cell<u32>> {
        let listings = Rc::new(Cell::new(0));
        let (seen, ended) = (Rc::clone(&listings), Cell::new(false));
        let (directory, threads) = (
            self.task(TASK),
            self.cgroup(&id('d')).join("cgroup.threads"),
        );
        let listing = format!("box/docker-{}.scope/cgroup.threads", id('d'));
        self.intercept(move |path| {
            if path == at && !ended.replace(true) {
                fs::remove_dir_all(&directory).unwrap();
            }
            if path != listing || !ended.get() {
                return None;
            }
            seen.set(seen.get() + 1);
            if seen.get() == relisting {
                list(&threads, &[MEMBER.0]);
            }
            None
        });
        listings
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        let close = self.files.close_all();
        fs::remove_dir_all(&self.root).unwrap();
        if !std::thread::panicking() {
            assert!(close.is_empty());
        }
    }
}
fn refusal(result: Result<impl Sized>) -> String {
    match result {
        Ok(_) => panic!("refusal required"),
        Err(error) => error.to_string(),
    }
}
const GONE: &str = "BOXED_RESOURCE_IO: No such file or directory (os error 2)";

#[test]
fn owned_box_binds_and_stays_current() {
    let mut tree = Tree::new();
    let scope = tree.bind().unwrap();
    assert_eq!(scope.processes.len(), 3);
    assert_eq!(scope.processes[1].identity.start_ticks, "456");
    for _ in 0..3 {
        scope.assert_current(&mut tree.files).unwrap();
    }
}
#[test]
fn task_that_ends_between_its_listing_and_any_of_its_reads_is_a_departure() {
    for at in ["proc/77", "proc/77/cgroup", "proc/77/stat"] {
        let mut tree = Tree::new();
        let scope = tree.bind().unwrap();
        let listings = tree.end_task(at, 1);
        scope.assert_current(&mut tree.files).unwrap();
        assert_eq!(listings.get(), 1, "{at}");
        // The next check sees an ordinary cgroup without the task.
        scope.assert_current(&mut tree.files).unwrap();
    }
}
#[test]
fn task_ending_while_the_scope_is_captured_is_a_departure() {
    let mut tree = Tree::new();
    tree.end_task("proc/77/stat", 1);
    tree.bind().unwrap();
}
#[test]
fn read_finding_no_task_behind_an_open_file_is_a_departure() {
    let mut tree = Tree::new();
    let scope = tree.bind().unwrap();
    let threads = tree.cgroup(&id('d')).join("cgroup.threads");
    tree.intercept(move |path| {
        (path == "proc/77/cgroup").then(|| {
            list(&threads, &[MEMBER.0]);
            io::Error::from_raw_os_error(libc::ESRCH)
        })
    });
    scope.assert_current(&mut tree.files).unwrap();
}
#[test]
fn task_whose_record_shows_it_exited_is_a_departure() {
    for state in ["Z", "X", "x"] {
        let mut tree = Tree::new();
        let scope = tree.bind().unwrap();
        record(&tree.task(TASK), &id('d'), TASK, state, MEMBER.1);
        let threads = tree.cgroup(&id('d')).join("cgroup.threads");
        tree.intercept(move |path| {
            if path == "proc/77/stat" {
                list(&threads, &[MEMBER.0]);
            }
            None
        });
        scope.assert_current(&mut tree.files).unwrap();
    }
}
#[test]
fn task_is_a_departure_only_once_a_later_listing_drops_it() {
    let mut tree = Tree::new();
    let scope = tree.bind().unwrap();
    let listings = tree.end_task("proc/77", 3);
    scope.assert_current(&mut tree.files).unwrap();
    assert_eq!(listings.get(), 3);
}
#[test]
fn task_that_stays_listed_but_unreadable_refuses_naming_its_path_and_owner() {
    let mut tree = Tree::new();
    let scope = tree.bind().unwrap();
    let listings = tree.end_task("proc/77", u32::MAX);
    assert_eq!(
        refusal(scope.assert_current(&mut tree.files)),
        format!(
            "{GONE} at {} (member {} task 77)",
            tree.text("proc/77"),
            id('d')
        )
    );
    // One listing after each bounded pause, then no more.
    assert_eq!(listings.get(), 5);
}
#[test]
fn exited_record_that_stays_listed_refuses() {
    let mut tree = Tree::new();
    let scope = tree.bind().unwrap();
    record(&tree.task(TASK), &id('d'), TASK, "Z", MEMBER.1);
    assert_eq!(
        refusal(scope.assert_current(&mut tree.files)),
        "BOXED_RESOURCE_PID_EXITED"
    );
}
#[test]
fn live_task_naming_another_cgroup_refuses_at_once() {
    let mut tree = Tree::new();
    let scope = tree.bind().unwrap();
    record(&tree.task(TASK), &id('c'), TASK, "S", MEMBER.1);
    let listings = Rc::new(Cell::new(0));
    let (seen, threads) = (
        Rc::clone(&listings),
        tree.cgroup(&id('d')).join("cgroup.threads"),
    );
    tree.intercept(move |path| {
        if path.ends_with(&format!("docker-{}.scope/cgroup.threads", id('d'))) {
            seen.set(seen.get() + 1);
        }
        if path == "proc/77/cgroup" {
            // Even a cgroup that no longer lists it does not excuse the claim.
            list(&threads, &[MEMBER.0]);
        }
        None
    });
    assert_eq!(
        refusal(scope.assert_current(&mut tree.files)),
        "BOXED_RESOURCE_FOREIGN_PID"
    );
    assert_eq!(listings.get(), 1);
}
#[test]
fn only_absence_of_the_task_is_a_departure() {
    for errno in [libc::EACCES, libc::EIO, libc::EMFILE, libc::ELOOP] {
        let mut tree = Tree::new();
        let scope = tree.bind().unwrap();
        let threads = tree.cgroup(&id('d')).join("cgroup.threads");
        tree.intercept(move |path| {
            (path == "proc/77/stat").then(|| {
                list(&threads, &[MEMBER.0]);
                io::Error::from_raw_os_error(errno)
            })
        });
        let error = scope.assert_current(&mut tree.files).unwrap_err();
        assert_eq!(error.errno(), Some(errno));
        assert!(!departed(&error));
        assert!(error.to_string().ends_with(&format!(
            " at {} (member {} task 77)",
            tree.text("proc/77/stat"),
            id('d')
        )));
    }
    let absent = || Error::from(io::Error::from_raw_os_error(libc::ENOENT));
    assert!(departed(&absent()));
    assert!(departed(&Error::Refused("BOXED_RESOURCE_PID_EXITED")));
    for code in ["BOXED_RESOURCE_PID_STAT", "BOXED_RESOURCE_FOREIGN_PID"] {
        assert!(!departed(&Error::Refused(code)));
    }
    // An absence that also lost a close is not a plain absence.
    let lost: Result<()> = finalized(
        Err(absent()),
        vec![io::Error::from_raw_os_error(libc::EINTR)],
    );
    assert!(!departed(&lost.unwrap_err()));
}
#[test]
fn truncated_record_is_malformed_not_exited() {
    let mut tree = Tree::new();
    let scope = tree.bind().unwrap();
    fs::write(tree.task(TASK).join("stat"), "77 (busy loop) S 0\n").unwrap();
    assert_eq!(
        refusal(scope.assert_current(&mut tree.files)),
        "BOXED_RESOURCE_PID_STAT"
    );
}
#[test]
fn vanished_anchor_or_worker_refuses_naming_it() {
    for (init, role, container) in [(ANCHOR.0, "anchor", id('b')), (WORKER.0, "worker", id('c'))] {
        let mut tree = Tree::new();
        let scope = tree.bind().unwrap();
        fs::remove_dir_all(tree.task(init)).unwrap();
        // Its cgroup no longer listing it changes nothing.
        list(&tree.cgroup(&container).join("cgroup.threads"), &[]);
        assert_eq!(
            refusal(scope.assert_current(&mut tree.files)),
            format!(
                "{GONE} at {} ({role} {container})",
                tree.text(&format!("proc/{init}/stat"))
            )
        );
    }
}
#[test]
fn init_that_ends_during_its_own_census_is_never_a_departure() {
    let mut tree = Tree::new();
    let scope = tree.bind().unwrap();
    let (directory, threads) = (
        tree.task(WORKER.0),
        tree.cgroup(&id('c')).join("cgroup.threads"),
    );
    let opens = Cell::new(0);
    tree.intercept(move |path| {
        if path == "proc/43" {
            opens.set(opens.get() + 1);
        }
        // The first open is the pinned identity check; the second, the census.
        if path == "proc/43" && opens.get() == 2 {
            fs::remove_dir_all(&directory).unwrap();
            list(&threads, &[]);
        }
        None
    });
    assert_eq!(
        refusal(scope.assert_current(&mut tree.files)),
        format!(
            "{GONE} at {} (worker {} task 43)",
            tree.text("proc/43"),
            id('c')
        )
    );
}
#[test]
fn absent_process_or_cgroup_refuses_capture_naming_it() {
    let mut tree = Tree::new();
    fs::remove_dir_all(tree.task(WORKER.0)).unwrap();
    assert_eq!(
        refusal(tree.bind()),
        format!("{GONE} at {} (worker {})", tree.text("proc/43"), id('c'))
    );
    let mut tree = Tree::new();
    fs::remove_dir_all(tree.cgroup(&id('d'))).unwrap();
    assert_eq!(
        refusal(tree.bind()),
        format!(
            "{GONE} at {} (member {})",
            tree.text(&format!("box/docker-{}.scope", id('d'))),
            id('d')
        )
    );
    let mut tree = Tree::new();
    fs::remove_file(tree.root.join("box/cgroup.procs")).unwrap();
    assert_eq!(
        refusal(tree.bind()),
        format!("{GONE} at {} (box)", tree.text("box/cgroup.procs"))
    );
}
#[test]
fn changed_birth_refuses_at_capture_and_afterwards() {
    let mut tree = Tree::new();
    record(&tree.task(WORKER.0), &id('c'), WORKER.0, "S", WORKER.1 + 1);
    assert_eq!(refusal(tree.bind()), "BOXED_RESOURCE_PID_CHANGED");
    let mut tree = Tree::new();
    let scope = tree.bind().unwrap();
    record(&tree.task(ANCHOR.0), &id('b'), ANCHOR.0, "S", ANCHOR.1 + 1);
    assert_eq!(
        refusal(scope.assert_current(&mut tree.files)),
        "BOXED_RESOURCE_PID_CHANGED"
    );
}
#[test]
fn replaced_process_and_changed_membership_refuse() {
    let mut tree = Tree::new();
    let scope = tree.bind().unwrap();
    fs::rename(tree.task(WORKER.0), tree.root.join("proc/old")).unwrap();
    record(&tree.task(WORKER.0), &id('c'), WORKER.0, "S", WORKER.1);
    assert_eq!(
        refusal(scope.assert_current(&mut tree.files)),
        "BOXED_RESOURCE_PID_REPLACED"
    );
    let mut tree = Tree::new();
    let scope = tree.bind().unwrap();
    list(&tree.cgroup(&id('d')).join("cgroup.procs"), &[TASK]);
    assert_eq!(
        refusal(scope.assert_current(&mut tree.files)),
        "BOXED_RESOURCE_INIT_NOT_MEMBER"
    );
    let mut tree = Tree::new();
    let scope = tree.bind().unwrap();
    fs::create_dir(tree.cgroup(&id('e'))).unwrap();
    assert_eq!(
        refusal(scope.assert_current(&mut tree.files)),
        "BOXED_RESOURCE_FOREIGN_CHILD"
    );
}
/// The kernel's own answers for a task that ended, read the two ways the
/// census reads them: by name, and below a directory opened while it lived.
#[test]
fn native_process_filesystem_reports_an_ended_thread_as_a_departure() {
    let (report, reported) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    let thread = std::thread::spawn(move || {
        let own = fs::read_link("/proc/thread-self").unwrap();
        report
            .send(own.file_name().unwrap().to_str().unwrap().to_owned())
            .unwrap();
        released.recv().ok();
    });
    let task = reported.recv().unwrap();
    let mut files = Files::new();
    let root = files.storage("/proc", false).unwrap();
    let live = files.child(root, &task, statfs::PROC_SUPER_MAGIC).unwrap();
    assert!(files.read(live, "stat", 4096).unwrap().starts_with(&task));
    drop(release);
    thread.join().unwrap();
    // Joining returns before the kernel has released the task.
    let end = Instant::now() + Duration::from_secs(10);
    let named = loop {
        match files.child(root, &task, statfs::PROC_SUPER_MAGIC) {
            Err(error) => break error,
            Ok(index) => files.release(index).unwrap(),
        }
        assert!(Instant::now() < end, "thread never released");
        std::thread::sleep(Duration::from_millis(1));
    };
    assert_eq!(named.to_string(), format!("{GONE} at /proc/{task}"));
    assert!(departed(&named));
    for name in ["stat", "cgroup"] {
        let error = files.read(live, name, 4096).unwrap_err();
        assert!(departed(&error), "{error}");
        assert!(
            error
                .to_string()
                .ends_with(&format!(" at /proc/{task}/{name}"))
        );
    }
    assert!(files.close_all().is_empty());
}
