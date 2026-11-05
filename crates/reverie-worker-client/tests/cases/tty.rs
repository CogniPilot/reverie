use crate::support::*;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::process::Stdio;
use std::time::{Duration, Instant};

struct Pty {
    master: File,
    slave: File,
}
impl Pty {
    #[allow(unsafe_code)]
    fn new() -> Self {
        // SAFETY: fresh CLOEXEC master; grant/unlock affect only this owned PTY.
        let master = unsafe { libc::posix_openpt(libc::O_RDWR | libc::O_CLOEXEC | libc::O_NOCTTY) };
        assert!(master >= 0);
        let master = unsafe { File::from_raw_fd(master) };
        assert_eq!(unsafe { libc::grantpt(master.as_raw_fd()) }, 0);
        assert_eq!(unsafe { libc::unlockpt(master.as_raw_fd()) }, 0);
        let mut name = [0_i8; 1024];
        assert_eq!(
            unsafe { libc::ptsname_r(master.as_raw_fd(), name.as_mut_ptr(), name.len()) },
            0
        );
        // SAFETY: ptsname_r returned terminated owned slave name; new fd moves once.
        let slave = unsafe {
            libc::open(
                name.as_ptr(),
                libc::O_RDWR | libc::O_CLOEXEC | libc::O_NOCTTY,
            )
        };
        assert!(slave >= 0);
        let result = Self {
            master,
            slave: unsafe { File::from_raw_fd(slave) },
        };
        result.resize(97, 31);
        result
    }
    #[allow(unsafe_code)]
    fn resize(&self, cols: u16, rows: u16) {
        let size = libc::winsize {
            ws_col: cols,
            ws_row: rows,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: exact initialized winsize for owned PTY only.
        assert_eq!(
            unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ, &size) },
            0
        );
    }
    #[allow(unsafe_code)]
    fn attributes(&self) -> libc::termios {
        // SAFETY: initialized output storage for the owned slave.
        let mut attributes: libc::termios = unsafe { std::mem::zeroed() };
        assert_eq!(
            unsafe { libc::tcgetattr(self.slave.as_raw_fd(), &mut attributes) },
            0
        );
        attributes
    }
    fn restored(&self, before: &libc::termios) {
        let after = self.attributes();
        assert_eq!(
            (
                before.c_iflag,
                before.c_oflag,
                before.c_cflag,
                before.c_lflag,
                before.c_cc
            ),
            (
                after.c_iflag,
                after.c_oflag,
                after.c_cflag,
                after.c_lflag,
                after.c_cc
            )
        );
    }
    fn raw(&self) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while self.attributes().c_lflag & libc::ICANON != 0 {
            assert!(Instant::now() < deadline, "client did not enter raw mode");
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}
#[allow(unsafe_code)]
fn signal(child: &Process, signal: i32) {
    // SAFETY: owned child remains unreaped until Process::wait, so PID cannot recycle.
    assert_eq!(unsafe { libc::kill(child.child.id() as i32, signal) }, 0);
}
#[allow(unsafe_code)]
fn flags(file: &File) -> i32 {
    // SAFETY: read-only query of owned fixture descriptor.
    let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
    assert!(flags >= 0);
    flags
}
#[test]
fn real_pty_bytes_resize_and_terminal_flags_are_restored() {
    let tree = Tree::new();
    let mut pty = Pty::new();
    let before = pty.attributes();
    let before_flags = flags(&pty.slave);
    let mut command = tree.command(&[
        "--session-id",
        SID,
        "--cwd",
        "/workspace",
        "--command",
        "never executed",
    ]);
    command
        .stdin(Stdio::from(pty.slave.try_clone().unwrap()))
        .stdout(Stdio::from(pty.slave.try_clone().unwrap()));
    let child = Process::spawn(&mut command);
    let mut broker = tree.accept();
    let (_, raw) = receive(&mut broker);
    let request: serde_json::Value = serde_json::from_slice(&raw).unwrap();
    assert_eq!(request["cols"], 97);
    assert_eq!(request["rows"], 31);
    pty.raw();
    pty.master.write_all(b"raw\x03\0bytes").unwrap();
    assert_eq!(receive(&mut broker), (b'I', b"raw\x03\0bytes".to_vec()));
    pty.resize(131, 43);
    signal(&child, libc::SIGWINCH);
    let (kind, raw) = receive(&mut broker);
    assert_eq!(kind, b'R');
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&raw).unwrap(),
        serde_json::json!([131, 43])
    );
    send(&mut broker, b'O', b"raw\noutput");
    let mut bytes = [0; 10];
    pty.master.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"raw\noutput");
    send(&mut broker, b'X', b"0");
    let output = child.wait();
    assert!(output.status.success(), "{:?}", output.stderr);
    pty.restored(&before);
    assert_eq!(flags(&pty.slave), before_flags);
}

#[test]
fn resize_during_large_initial_send_is_retained_until_relay_starts() {
    let tree = Tree::new();
    let pty = Pty::new();
    let before = pty.attributes();
    let command_text = "x".repeat(120_000);
    let mut command = tree.command(&[
        "--session-id",
        SID,
        "--cwd",
        "/workspace",
        "--command",
        &command_text,
    ]);
    command
        .env("CODEX_ONE", "a".repeat(60_000))
        .env("CODEX_TWO", "b".repeat(60_000))
        .stdin(Stdio::from(pty.slave.try_clone().unwrap()));
    let child = Process::spawn(&mut command);
    let mut broker = tree.accept();
    pty.raw();
    pty.resize(141, 53);
    signal(&child, libc::SIGWINCH);
    let (kind, raw) = receive(&mut broker);
    assert_eq!(kind, b'J');
    assert!(raw.len() > 230_000);
    let (kind, raw) = receive(&mut broker);
    assert_eq!(kind, b'R');
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&raw).unwrap(),
        serde_json::json!([141, 53])
    );
    send(&mut broker, b'X', b"0");
    assert!(child.wait().status.success());
    pty.restored(&before);
}

#[allow(unsafe_code)]
fn owned_pipe() -> (File, File) {
    let mut descriptors = [-1; 2];
    // SAFETY: exact two-fd output; CLOEXEC is atomic before any process spawn.
    assert_eq!(
        unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) },
        0
    );
    unsafe {
        (
            File::from_raw_fd(descriptors[0]),
            File::from_raw_fd(descriptors[1]),
        )
    }
}
#[allow(unsafe_code)]
fn pipe_full(reader: &File) {
    // SAFETY: read-only queries on the owned pipe, initialized integer output.
    let size = unsafe { libc::fcntl(reader.as_raw_fd(), libc::F_GETPIPE_SZ) };
    assert!(size > 0);
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let mut available = 0_i32;
        assert_eq!(
            unsafe { libc::ioctl(reader.as_raw_fd(), libc::FIONREAD, &mut available) },
            0
        );
        if available == size {
            break;
        }
        assert!(Instant::now() < deadline, "output pipe never filled");
        std::thread::sleep(Duration::from_millis(2));
    }
}
#[test]
fn blocked_stdout_cancels_promptly_and_restores_tty_without_changing_parent_flags() {
    let tree = Tree::new();
    let pty = Pty::new();
    let before = pty.attributes();
    let (reader, writer) = owned_pipe();
    let parent_writer = writer.try_clone().unwrap();
    let before_flags = flags(&parent_writer);
    let mut command = tree.command(&[
        "--session-id",
        SID,
        "--cwd",
        "/workspace",
        "--command",
        "never executed",
    ]);
    command
        .stdin(Stdio::from(pty.slave.try_clone().unwrap()))
        .stdout(Stdio::from(writer));
    let child = Process::spawn(&mut command);
    let mut broker = tree.accept();
    receive(&mut broker);
    send(&mut broker, b'O', &vec![b'x'; 262_144]);
    pipe_full(&reader);
    assert_eq!(flags(&parent_writer), before_flags);
    let started = Instant::now();
    signal(&child, libc::SIGTERM);
    let output = child.wait();
    assert_eq!(output.status.code(), Some(143));
    assert!(started.elapsed() < Duration::from_secs(2));
    pty.restored(&before);
    assert_eq!(flags(&parent_writer), before_flags);
}
#[test]
fn regular_stdout_preserves_shared_offset_and_append_behavior() {
    for append in [false, true] {
        let tree = Tree::new();
        let path = tree.root.join("output");
        std::fs::write(&path, b"prefix").unwrap();
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .append(append)
            .open(&path)
            .unwrap();
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::Start(if append { 0 } else { 6 }))
            .unwrap();
        let before_flags = flags(&file);
        let observer = file.try_clone().unwrap();
        let mut command = tree.command(&[
            "--session-id",
            SID,
            "--cwd",
            "/workspace",
            "--command",
            "never executed",
        ]);
        command.stdout(Stdio::from(file));
        let child = Process::spawn(&mut command);
        let mut broker = tree.accept();
        receive(&mut broker);
        send(&mut broker, b'O', b"suffix");
        send(&mut broker, b'X', b"0");
        assert!(child.wait().status.success());
        assert_eq!(std::fs::read(&path).unwrap(), b"prefixsuffix");
        assert_eq!(flags(&observer), before_flags);
        let mut observer = observer;
        assert_eq!(observer.stream_position().unwrap(), 12);
    }
}

#[test]
fn initial_request_send_backpressure_remains_cancellable_and_restores_tty() {
    let tree = Tree::new();
    let pty = Pty::new();
    let before = pty.attributes();
    let command_text = "x".repeat(120_000);
    let mut command = tree.command(&[
        "--session-id",
        SID,
        "--cwd",
        "/workspace",
        "--command",
        &command_text,
    ]);
    command
        .env("CODEX_ONE", "a".repeat(60_000))
        .env("CODEX_TWO", "b".repeat(60_000))
        .stdin(Stdio::from(pty.slave.try_clone().unwrap()));
    let child = Process::spawn(&mut command);
    let _broker = tree.accept();
    pty.raw();
    let started = Instant::now();
    signal(&child, libc::SIGTERM);
    assert_eq!(child.wait().status.code(), Some(143));
    assert!(started.elapsed() < Duration::from_secs(2));
    pty.restored(&before);
}

#[test]
fn sustained_output_frames_cannot_starve_signal_cancellation_or_tty_restoration() {
    let tree = Tree::new();
    let pty = Pty::new();
    let before = pty.attributes();
    let mut command = tree.command(&[
        "--session-id",
        SID,
        "--cwd",
        "/workspace",
        "--command",
        "never executed",
    ]);
    command.stdin(Stdio::from(pty.slave.try_clone().unwrap()));
    let child = Process::spawn(&mut command);
    let mut broker = tree.accept();
    receive(&mut broker);
    let (ready, started) = std::sync::mpsc::sync_channel(1);
    let producer = std::thread::spawn(move || {
        let mut wire = vec![b'O'];
        wire.extend_from_slice(&1024_u32.to_be_bytes());
        wire.extend_from_slice(&[b'x'; 1024]);
        let deadline = Instant::now() + Duration::from_secs(3);
        for index in 0..32768 {
            if broker.write_all(&wire).is_err() {
                break;
            }
            if index == 128 {
                ready.send(()).unwrap();
            }
            if Instant::now() >= deadline {
                break;
            }
        }
    });
    started.recv_timeout(Duration::from_secs(3)).unwrap();
    let begin = Instant::now();
    signal(&child, libc::SIGTERM);
    let output = child.wait();
    assert_eq!(output.status.code(), Some(143));
    assert!(begin.elapsed() < Duration::from_secs(2));
    pty.restored(&before);
    producer.join().unwrap();
}

#[test]
fn continuous_output_still_forwards_keyboard_input_and_pending_resize_promptly() {
    let tree = Tree::new();
    let mut pty = Pty::new();
    let before = pty.attributes();
    let mut command = tree.command(&[
        "--session-id",
        SID,
        "--cwd",
        "/workspace",
        "--command",
        "never executed",
    ]);
    command
        .stdin(Stdio::from(pty.slave.try_clone().unwrap()))
        .stdout(Stdio::from(
            std::fs::OpenOptions::new()
                .write(true)
                .open("/dev/null")
                .unwrap(),
        ));
    let child = Process::spawn(&mut command);
    let mut broker = tree.accept();
    receive(&mut broker);
    let mut writer = broker.try_clone().unwrap();
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop = done.clone();
    let (ready, started) = std::sync::mpsc::sync_channel(1);
    let producer = std::thread::spawn(move || {
        let mut wire = vec![b'O'];
        wire.extend_from_slice(&1024_u32.to_be_bytes());
        wire.extend_from_slice(&[b'x'; 1024]);
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut count = 0;
        while !stop.load(std::sync::atomic::Ordering::Relaxed) && Instant::now() < deadline {
            if writer.write_all(&wire).is_err() {
                break;
            }
            count += 1;
            if count == 128 {
                ready.send(()).unwrap();
            }
        }
    });
    started.recv_timeout(Duration::from_secs(3)).unwrap();
    let start = Instant::now();
    pty.master.write_all(b"keyboard\x03").unwrap();
    pty.resize(151, 63);
    signal(&child, libc::SIGWINCH);
    let (mut input, mut resized) = (false, false);
    while !input || !resized {
        let (kind, raw) = receive(&mut broker);
        match kind {
            b'I' => {
                assert_eq!(raw, b"keyboard\x03");
                input = true;
            }
            b'R' => {
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&raw).unwrap(),
                    serde_json::json!([151, 63])
                );
                resized = true;
            }
            _ => panic!("unexpected frame"),
        }
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "busy output starved terminal input/resize"
        );
    }
    done.store(true, std::sync::atomic::Ordering::Relaxed);
    producer.join().unwrap();
    send(&mut broker, b'X', b"0");
    assert!(child.wait().status.success());
    pty.restored(&before);
}
