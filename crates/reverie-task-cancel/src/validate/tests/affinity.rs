//! Bind only the two positive synthetic closures to the CPU set they declare.
//! Neither the parent test process nor production validation is relaxed.
use super::{MAX_CPUS, current_affinity, scratch};
use std::{
    collections::BTreeSet,
    io::Read,
    os::unix::fs::OpenOptionsExt,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub(super) fn selection(allowed: &BTreeSet<usize>) -> Vec<usize> {
    allowed.iter().take(MAX_CPUS).copied().collect()
}

pub(super) fn isolate_case(name: &str) -> bool {
    const MARKER: &str = "REVERIE_TASK_CANCEL_POSITIVE_AFFINITY";
    assert!(matches!(
        name,
        "validate::tests::a_complete_closure_validates"
            | "validate::tests::a_pending_operation_refuses_a_run_but_not_a_source_check"
    ));
    let original = current_affinity().unwrap();
    assert!(!original.is_empty());
    let selected = selection(&original);
    let list = selected
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let marker = format!("{name}:{list}");
    if let Some(actual) = std::env::var_os(MARKER) {
        assert_eq!(actual.as_os_str(), std::ffi::OsStr::new(&marker));
        assert!(
            original.len() <= MAX_CPUS,
            "child must have the declared finite CPU set"
        );
        return false;
    }
    if original.len() <= MAX_CPUS {
        return false;
    }

    let directory = scratch();
    let log = directory.join("positive-test.log");
    let output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&log)
        .unwrap();
    let mut child = Command::new("taskset")
        .args(["-c", &list])
        .arg(std::env::current_exe().unwrap())
        .args(["--exact", name, "--test-threads=1", "--nocapture"])
        .env(MARKER, marker)
        .stdin(Stdio::null())
        .stdout(output.try_clone().unwrap())
        .stderr(output)
        .spawn()
        .unwrap();
    let end = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= end {
            let killed = child.kill();
            let reaped = child.wait();
            panic!(
                "isolated positive test timed out: kill={killed:?}, reap={reaped:?}; log={}",
                log.display()
            );
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(child.wait().unwrap(), status);
    let mut raw = Vec::new();
    std::fs::File::open(&log)
        .unwrap()
        .take(65_537)
        .read_to_end(&mut raw)
        .unwrap();
    assert!(raw.len() <= 65_536, "bounded child output");
    let text = String::from_utf8(raw).unwrap();
    assert!(status.success(), "isolated {name}: {text}");
    assert!(
        text.contains("test result: ok. 1 passed; 0 failed;"),
        "exact positive body must execute once: {text}"
    );
    assert_eq!(
        current_affinity().unwrap(),
        original,
        "parent affinity stays unchanged"
    );
    std::fs::remove_dir_all(directory).unwrap();
    true
}
