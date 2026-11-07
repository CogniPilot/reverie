//! Actual accepted child peer and pinned pidfd, with no protected-status or
//! program/website/owner assertion. Every owned child is reaped before verdict.
use super::*;
use crate::website_facts::{WebsiteProcessObserver, process_test_metadata};
use std::{
    os::fd::OwnedFd,
    process::{Child, Command, ExitStatus, Stdio},
};
fn close_listener(listener: UnixListener) -> crate::observation::Result<()> {
    crate::native::close(std::fs::File::from(OwnedFd::from(listener)))
}
fn finish(child: &mut Child) -> std::io::Result<ExitStatus> {
    let stop = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if Instant::now() >= stop {
            child.kill()?;
            return child.wait();
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn child_peer(fixture: &Fixture) -> (Child, UnixStream) {
    let path = fixture.root.join("ancestry");
    let listener = UnixListener::bind(&path).unwrap();
    if let Err(error) = listener.set_nonblocking(true) {
        close_listener(listener).unwrap();
        panic!("owned listener configuration: {error}");
    }
    let spawned = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "worker_reports::tests::resume_channel::ancestry::ancestry_child",
        ])
        .env("REVERIE_ANCESTRY_SOCKET", &path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            close_listener(listener).unwrap();
            panic!("fixed owned child spawn: {error}");
        }
    };
    let end = Instant::now() + Duration::from_secs(5);
    let accepted = loop {
        match listener.accept() {
            Ok((server, _)) => break Ok(server),
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < end =>
            {
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(error) => break Err(error),
        }
    };
    let closed = close_listener(listener);
    if accepted.is_err() {
        let joined = finish(&mut child);
        closed.unwrap();
        joined.unwrap();
        panic!("owned child connection: {:?}", accepted.err());
    }
    closed.unwrap();
    (child, accepted.unwrap())
}
#[test]
fn actual_pinned_child_peer_walks_to_owned_parent_with_same_namespace_and_incarnation_brackets() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (mut child, server) = child_peer(&fixture);
    let mut channel = accepted(&fixture, &service, server)
        .retain_resource_website_channel(&fixture.runtime)
        .ok()
        .unwrap();
    let result = (|| {
        channel.pin_peer()?;
        channel.greet(end())?;
        let parent = process_test_metadata(std::process::id());
        let mut observer = WebsiteProcessObserver::default();
        observer.observe_peer_ancestry(&mut channel, &parent, end())
    })();
    let peer_pid = channel.peer().pid();
    let closed = channel.close_for_worker();
    let joined = finish(&mut child);
    let service_closed = service.close(end());
    closed.unwrap();
    let status = joined.unwrap();
    service_closed.unwrap();
    assert!(status.success());
    let observed = result.unwrap();
    assert_eq!(peer_pid, child.id() as i32);
    assert_eq!(observed.peer_identity().pid(), child.id() as i32);
    assert_eq!(observed.peer().pid().to_u64(), Some(u64::from(child.id())));
    assert_eq!(
        observed.peer().parent().to_u64(),
        Some(u64::from(std::process::id()))
    );
    assert_eq!(
        observed.init().pid().to_u64(),
        Some(u64::from(std::process::id()))
    );
    assert_eq!(observed.peer().namespaces(), observed.init().namespaces());
}
#[test]
fn actual_same_pid_ancestry_is_data_and_known_closed_channel_refuses_before_proc_reads() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (client, mut channel) = channel(&fixture, &service);
    let metadata = process_test_metadata(std::process::id());
    let mut observer = WebsiteProcessObserver::default();
    let observed = observer.observe_peer_ancestry(&mut channel, &metadata, end());
    let closed = channel.close_for_worker();
    let refused = observer.observe_peer_ancestry(&mut channel, &metadata, end());
    let client_closed = super::super::super::record::close(client);
    let service_closed = service.close(end());
    closed.unwrap();
    client_closed.unwrap();
    service_closed.unwrap();
    assert!(refused.is_err());
    let value = observed.unwrap();
    assert_eq!(value.peer(), value.init());
    assert_eq!(value.peer_identity().pid(), std::process::id() as i32);
}
#[test]
#[ignore = "fixed owned child invoked only by the actual ancestry control"]
fn ancestry_child() {
    let path = std::env::var_os("REVERIE_ANCESTRY_SOCKET").unwrap();
    let mut stream = UnixStream::connect(path).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let outcome = (|| {
        send(
            &mut stream,
            b'Q',
            br#"{"purpose":"resource-replacement-v1","version":1}"#,
        );
        let mut greeting = [0; 15];
        stream.read_exact(&mut greeting)?;
        if greeting != *b"RESOURCE_READY\n" {
            return Err(std::io::Error::other("unexpected fixed greeting"));
        }
        let mut byte = [0];
        if stream.read(&mut byte)? != 0 {
            return Err(std::io::Error::other("unexpected fixed control data"));
        }
        Ok(())
    })();
    let closed = super::super::super::record::close(stream);
    outcome.unwrap();
    closed.unwrap();
}
