//! Original contained child identity, not a caller-selected process capability.
use super::*;
use std::{fs::File, os::fd::AsFd};

pub(super) struct OriginalChild<'a> {
    scope: &'a transport::Scope,
    pid: u32,
    start: String,
    fd: Option<File>,
}
impl<'a> OriginalChild<'a> {
    pub(super) fn open(scope: &'a transport::Scope, pid: u32) -> Self {
        let start = start(scope, pid);
        let mut owner = Self {
            scope,
            pid,
            start,
            fd: None,
        };
        // The PID came from the fixed orphan in this already proven fixture
        // namespace. The same reviewed read-only pidfd primitive opens it;
        // this code never signals a PID, and starts no fresh process.
        owner.fd = Some(crate::native::perf_init_pidfd(pid).unwrap());
        assert!(!owner.dead());
        owner.current();
        owner
    }
    pub(super) fn current(&self) {
        assert_eq!(
            self.start,
            start(self.scope, self.pid),
            "original orphan PID reused"
        );
    }
    pub(super) fn dead(&self) -> bool {
        let fd = self.fd.as_ref().expect("original live pidfd owner");
        let mut descriptors = [nix::poll::PollFd::new(
            fd.as_fd(),
            nix::poll::PollFlags::POLLIN,
        )];
        let ready = nix::poll::poll(&mut descriptors, nix::poll::PollTimeout::ZERO).unwrap();
        let events = descriptors[0].revents().unwrap();
        assert!(!events.intersects(nix::poll::PollFlags::POLLERR | nix::poll::PollFlags::POLLNVAL));
        match ready {
            0 => {
                assert!(events.is_empty());
                false
            }
            1 => {
                assert!(
                    events.intersects(nix::poll::PollFlags::POLLIN | nix::poll::PollFlags::POLLHUP)
                );
                true
            }
            _ => panic!("original orphan pidfd observation"),
        }
    }
    pub(super) fn close(&mut self) -> Result<(), crate::ObservationError> {
        self.scope.checked(crate::native::close(
            self.fd.take().expect("one checked original pidfd close"),
        ))
    }
}
fn start(scope: &transport::Scope, pid: u32) -> String {
    let raw = scope.read(&format!("/proc/{pid}/stat"), 65536).unwrap();
    reverie_contracts::worker_cold_tmp::ReferenceProcessIdentity::parse(&raw)
        .unwrap()
        .start()
        .to_owned()
}
impl Drop for OriginalChild<'_> {
    fn drop(&mut self) {
        if let Some(fd) = self.fd.take() {
            self.scope
                .retain_native("original orphan pidfd not checked closed");
            std::mem::forget(fd);
            if !std::thread::panicking() {
                panic!("original orphan pidfd was not checked closed");
            }
        }
    }
}
