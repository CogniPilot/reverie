use std::process::Command;
fn command() -> Command {
    Command::new(env!("CARGO_BIN_EXE_reverie-worker-child"))
}
#[test]
fn help_and_parser_do_not_enter_the_guest_runtime() {
    let help = command().arg("--help").output().unwrap();
    assert!(help.status.success());
    let text = String::from_utf8(help.stdout).unwrap();
    assert!(text.contains("/home/agent/.reverie-launch"));
    assert!(text.contains("--pane-exit"));
    for args in [vec![], vec!["--engine", "arbitrary"], vec!["one", "two"]] {
        assert_eq!(
            command().args(args).output().unwrap().status.code(),
            Some(2)
        );
    }
}
#[test]
fn unsupported_parent_refuses_without_reading_or_consuming_foreign_files() {
    let output = command()
        .arg("/not-a-private-launch/owned.json")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("record=Untouched")
    );
    let output = command()
        .args([
            "/not-a-private-launch/owned.json",
            "--pane-exit",
            "/not-a-private-launch/owned.exit",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("record=Untouched")
    );
}
#[test]
fn full_stderr_peer_does_not_block_actual_helper_failure_exit() {
    use std::{
        io::Write,
        os::{fd::OwnedFd, unix::net::UnixStream},
        process::Stdio,
        time::{Duration, Instant},
    };
    let (_reader, mut writer) = UnixStream::pair().unwrap();
    writer.set_nonblocking(true).unwrap();
    while writer.write(&[b'x'; 4096]).is_ok() {}
    writer.set_nonblocking(false).unwrap();
    let fd: OwnedFd = writer.into();
    let mut child = command()
        .arg("/not-a-private-launch/owned.json")
        .stderr(Stdio::from(fd))
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    let status = child.try_wait().unwrap();
    if status.is_none() {
        child.kill().unwrap();
        child.wait().unwrap();
    }
    assert_eq!(status.and_then(|status| status.code()), Some(1));
}
