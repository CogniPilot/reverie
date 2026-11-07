use std::{
    io::{Read, Write},
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

/// Test-owned children only. In the outer case this is the exact unshare
/// process whose --kill-child owns the entire private PID namespace.
pub(super) fn capture(command: &mut Command, input: &[u8], budget: Duration) -> Output {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let output = thread::spawn(move || {
        let mut raw = Vec::new();
        stdout.read_to_end(&mut raw).unwrap();
        raw
    });
    let diagnostics = thread::spawn(move || {
        let mut raw = Vec::new();
        stderr.read_to_end(&mut raw).unwrap();
        raw
    });
    let written = child.stdin.take().unwrap().write_all(input);
    let deadline = Instant::now() + budget;
    let mut expired = false;
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            expired = true;
            let _ = child.kill();
            break child.wait().unwrap();
        }
        thread::sleep(Duration::from_millis(10));
    };
    let stdout = output.join().unwrap();
    let stderr = diagnostics.join().unwrap();
    assert!(
        !expired,
        "owned child deadline: {command:?}; {status}; {}",
        String::from_utf8_lossy(&stderr)
    );
    assert!(
        written.is_ok() || input.is_empty() || !status.success(),
        "stdin delivery failed before a claimed success"
    );
    Output {
        status,
        stdout,
        stderr,
    }
}

pub(super) fn checked(command: &mut Command) -> Output {
    let output = capture(command, &[], Duration::from_secs(60));
    assert!(
        output.status.success(),
        "{command:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}
