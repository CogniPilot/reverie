#![cfg(target_os = "linux")]
#![allow(unsafe_code)]
//! Only owned pipes/files/socketpairs and separately owned Rust test processes.
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Seek, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{fs::OpenOptionsExt, net::UnixStream},
    },
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};
const ENTRY: &str = "entry";
static NEXT: AtomicUsize = AtomicUsize::new(0);
#[test]
fn entry() {
    let Ok(mode) = std::env::var("OWNED_DIAGNOSTIC") else {
        return;
    };
    if mode == "blocking-control" {
        std::io::stderr().write_all(b"owned-diagnostic\n").unwrap();
        return;
    }
    if mode == "sigpipe-default" {
        // SAFETY: only this separately owned test process changes its signal.
        unsafe {
            libc::signal(libc::SIGPIPE, libc::SIG_DFL);
        }
        assert_eq!(
            reverie_diagnostics::stderr(b"owned").unwrap_err().kind(),
            io::ErrorKind::Unsupported
        );
        return;
    }
    if mode == "tty-leader" {
        // SAFETY: only the separately owned fixture becomes a session leader.
        assert!(unsafe { libc::setsid() } > 0);
        reverie_diagnostics::stderr(b"owned").unwrap();
        // The adapter must not acquire a controlling terminal by reopening it.
        let fd = unsafe {
            libc::open(
                c"/dev/tty".as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOCTTY,
            )
        };
        if fd >= 0 {
            unsafe {
                libc::close(fd);
            }
        }
        assert!(fd < 0);
        return;
    }
    let data = if mode == "bound" {
        vec![b'x'; reverie_diagnostics::MAX_BYTES * 2]
    } else {
        b"owned-diagnostic\n".to_vec()
    };
    let result = reverie_diagnostics::stderr(&data);
    if mode == "regular" || mode == "bound" {
        result.unwrap();
    }
}
fn spawn(mode: &str, stderr: OwnedFd) -> Child {
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", ENTRY, "--nocapture"])
        .env("OWNED_DIAGNOSTIC", mode)
        .stderr(Stdio::from(stderr))
        .stdout(Stdio::null())
        .spawn()
        .unwrap()
}
fn completes(child: &mut Child, duration: Duration) -> bool {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success());
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    false
}
fn flags(fd: i32) -> i32 {
    // SAFETY: tests borrow live owned descriptors; F_GETFL changes nothing.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    assert!(flags >= 0);
    flags
}
fn set_nonblocking(fd: i32, nonblocking: bool) {
    let original = flags(fd);
    let wanted = if nonblocking {
        original | libc::O_NONBLOCK
    } else {
        original & !libc::O_NONBLOCK
    };
    // SAFETY: fixed owned test fd, no production/shared descriptor mutation.
    assert_eq!(unsafe { libc::fcntl(fd, libc::F_SETFL, wanted) }, 0);
}
fn full_pipe() -> (File, File) {
    let mut pair = [-1; 2];
    // SAFETY: live pair receives two newly owned anonymous pipe descriptors.
    assert_eq!(
        unsafe { libc::pipe2(pair.as_mut_ptr(), libc::O_CLOEXEC) },
        0
    );
    let reader = unsafe { File::from_raw_fd(pair[0]) };
    let mut writer = unsafe { File::from_raw_fd(pair[1]) };
    set_nonblocking(writer.as_raw_fd(), true);
    fill(&mut writer);
    set_nonblocking(writer.as_raw_fd(), false);
    (reader, writer)
}
fn fill(writer: &mut impl Write) {
    loop {
        match writer.write(&[b'f'; 4096]) {
            Ok(n) => assert!(n > 0),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            Err(error) => panic!("{error}"),
        }
    }
}
#[test]
fn full_inherited_pipe_has_blocking_control_but_bounded_transport_preserves_flags() {
    let (_reader, writer) = full_pipe();
    let before = flags(writer.as_raw_fd());
    let mut control = spawn("blocking-control", writer.try_clone().unwrap().into());
    assert!(!completes(&mut control, Duration::from_millis(100)));
    control.kill().unwrap();
    control.wait().unwrap();
    let mut child = spawn("emit", writer.try_clone().unwrap().into());
    let done = completes(&mut child, Duration::from_secs(2));
    if !done {
        child.kill().unwrap();
        child.wait().unwrap();
    }
    assert!(done);
    assert_eq!(flags(writer.as_raw_fd()), before);
}
#[test]
fn full_socket_is_nonblocking_without_altering_its_shared_description() {
    let (_reader, mut writer) = UnixStream::pair().unwrap();
    writer.set_nonblocking(true).unwrap();
    fill(&mut writer);
    writer.set_nonblocking(false).unwrap();
    let before = flags(writer.as_raw_fd());
    let mut child = spawn("emit", writer.try_clone().unwrap().into());
    let done = completes(&mut child, Duration::from_secs(2));
    if !done {
        child.kill().unwrap();
        child.wait().unwrap();
    }
    assert!(done);
    assert_eq!(flags(writer.as_raw_fd()), before);
}
#[test]
fn changed_sigpipe_disposition_omits_fifo_output_without_killing_the_process() {
    let (reader, writer) = full_pipe();
    drop(reader);
    let mut child = spawn("sigpipe-default", writer.into());
    assert!(completes(&mut child, Duration::from_secs(2)));
}
#[test]
fn reopened_tty_does_not_acquire_a_controlling_terminal_or_change_flags() {
    let (mut master, mut slave) = (-1, -1);
    // SAFETY: initialized output slots receive newly owned PTY descriptors;
    // default terminal attributes are sufficient for this tiny diagnostic.
    assert_eq!(
        unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
            )
        },
        0
    );
    let _master = unsafe { File::from_raw_fd(master) };
    let slave = unsafe { File::from_raw_fd(slave) };
    let before = flags(slave.as_raw_fd());
    let mut child = spawn("tty-leader", slave.try_clone().unwrap().into());
    assert!(completes(&mut child, Duration::from_secs(2)));
    assert_eq!(flags(slave.as_raw_fd()), before);
}
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "diagnostic-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn regular_file_offset_append_and_byte_bound_remain_exact() {
    let tree = Tree::new();
    for append in [false, true] {
        let path = tree.0.join(format!("{append}"));
        let mut file = OpenOptions::new()
            .write(true)
            .read(true)
            .create_new(true)
            .mode(0o600)
            .append(append)
            .open(&path)
            .unwrap();
        file.write_all(b"prefix").unwrap();
        if append {
            file.rewind().unwrap();
        }
        let before = flags(file.as_raw_fd());
        let mut child = spawn("regular", file.try_clone().unwrap().into());
        assert!(completes(&mut child, Duration::from_secs(2)));
        assert_eq!(file.stream_position().unwrap(), 23);
        assert_eq!(fs::read(&path).unwrap(), b"prefixowned-diagnostic\n");
        assert_eq!(flags(file.as_raw_fd()), before);
    }
    let path = tree.0.join("bound");
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap();
    let mut child = spawn("bound", file.into());
    assert!(completes(&mut child, Duration::from_secs(2)));
    assert_eq!(
        fs::read(path).unwrap().len(),
        reverie_diagnostics::MAX_BYTES
    );
}
