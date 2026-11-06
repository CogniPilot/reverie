use super::*;
use std::{
    os::fd::OwnedFd,
    process::{Command, Stdio},
};

#[test]
fn full_stderr_does_not_stall_connection_cap_or_cleanup() {
    const CHILD_FLAG: &str = "REVERIE_TEST_FRONT_FULL_STDERR";
    if std::env::var_os(CHILD_FLAG).is_some() {
        runtime().block_on(qualify_actor());
        return;
    }
    let (writer, _unread) = full_stderr();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "session::tests::stderr::full_stderr_does_not_stall_connection_cap_or_cleanup",
        ])
        .env(CHILD_FLAG, "child")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(OwnedFd::from(writer)))
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(
                status.success(),
                "full-stderr actor control failed: {status}"
            );
            break;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("front actor/cleanup blocked on inherited stderr");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn full_stderr() -> (UnixStream, UnixStream) {
    let (mut writer, reader) = UnixStream::pair().unwrap();
    writer.set_nonblocking(true).unwrap();
    loop {
        match writer.write(&[b'x'; 4096]) {
            Ok(size) => assert!(size > 0),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            Err(error) => panic!("fill stderr: {error}"),
        }
    }
    loop {
        match writer.write(b"x") {
            Ok(size) => assert_eq!(size, 1),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            Err(error) => panic!("fill last stderr byte: {error}"),
        }
    }
    writer.set_nonblocking(false).unwrap();
    (writer, reader)
}
async fn qualify_actor() {
    let h = Harness::start(1, 64);
    let port = h.peer.bind(Listener::Main).await;
    let (id, mut first) = h.peer.open(port, Listener::Main).await;
    assert_eq!(h.peer.receive().await.body, Body::Credit(64));
    let mut rejected = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    assert_eq!(rejected.read(&mut [0]).await.unwrap(), 0);
    first.write_all(b"still-serving").await.unwrap();
    h.peer.send(id, Body::Credit(64)).await;
    assert_eq!(
        h.peer.non_credit().await.body,
        Body::Data(b"still-serving".to_vec())
    );
    h.signals
        .send(Some(ShutdownRequest::new(Signal::Term)))
        .unwrap();
    assert!(matches!(
        h.peer.non_credit().await.body,
        Body::Shutdown { .. }
    ));
    assert_eq!(h.finish().await.unwrap(), SessionEnd::ChannelClosed);
}
