//! Actual accepted child peer and pinned pidfd, with no protected-status or
//! program/website/owner assertion. Every owned child is reaped before verdict.
mod fixture;
use super::*;
use crate::website_facts::{WebsiteProcessObserver, process_test_metadata};
use fixture::{PeerFixture, request};
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
#[test]
fn actual_pinned_child_peer_walks_to_owned_parent_with_same_namespace_and_incarnation_brackets() {
    let mut fixture = PeerFixture::new();
    let result = (|| {
        let child = fixture.connect_child()?;
        let observed = fixture.observe(std::process::id())?;
        Ok((child, observed))
    })();
    let (child, observed) = fixture.finish(result).unwrap();
    assert_eq!(observed.peer_identity().pid(), child as i32);
    assert_eq!(observed.peer().pid().to_u64(), Some(u64::from(child)));
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
    let mut fixture = PeerFixture::new();
    let result = (|| {
        fixture.connect_self()?;
        let observed = fixture.observe(std::process::id())?;
        fixture.close_channel()?;
        let refused = fixture.observe(std::process::id());
        Ok((observed, refused))
    })();
    let (observed, refused) = fixture.finish(result).unwrap();
    assert!(refused.is_err());
    assert_eq!(observed.peer(), observed.init());
    assert_eq!(observed.peer_identity().pid(), std::process::id() as i32);
}
#[test]
fn actual_parent_peer_cannot_claim_its_owned_child_as_init_and_all_owners_close_before_verdict() {
    let mut fixture = PeerFixture::new();
    let result = (|| {
        fixture.connect_self()?;
        let child = fixture.spawn_init()?;
        Ok(fixture.observe(child))
    })();
    let refused = fixture.finish(result).unwrap();
    // A real unrelated/reversed ancestry never succeeds. This does not claim
    // a 32-deep process farm or force a kernel visibility refusal into one code.
    assert!(refused.is_err());
}
#[test]
#[ignore = "fixed owned child invoked only by the actual ancestry control"]
fn ancestry_child() {
    let path = std::env::var_os("REVERIE_ANCESTRY_SOCKET").unwrap();
    let mut stream = UnixStream::connect(path).unwrap();
    let outcome = (|| {
        stream.set_read_timeout(Some(Duration::from_secs(10)))?;
        request(&mut stream)?;
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
