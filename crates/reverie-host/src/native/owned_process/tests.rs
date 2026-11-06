use super::*;
use std::os::unix::net::UnixDatagram;
use std::{
    fs,
    os::fd::AsRawFd,
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
fn send(socket: RawFd, descriptors: &[RawFd], payload: &[u8]) {
    let mut buffer = payload.to_vec();
    let mut iov = libc::iovec {
        iov_base: buffer.as_mut_ptr().cast(),
        iov_len: buffer.len(),
    };
    let mut control = [0usize; 32];
    // SAFETY: this test owns all passed files/socket; aligned stack storage is
    // large enough for the deliberately oversized private ancillary message.
    unsafe {
        let mut message: libc::msghdr = mem::zeroed();
        message.msg_iov = &mut iov;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen =
            libc::CMSG_SPACE(std::mem::size_of_val(descriptors) as u32) as usize;
        let header = libc::CMSG_FIRSTHDR(&message);
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN(std::mem::size_of_val(descriptors) as u32) as usize;
        std::ptr::copy_nonoverlapping(
            descriptors.as_ptr(),
            libc::CMSG_DATA(header).cast::<RawFd>(),
            descriptors.len(),
        );
        assert_eq!(
            libc::sendmsg(socket, &message, libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL),
            payload.len() as isize
        );
    }
}
fn references(path: &std::path::Path) -> usize {
    fs::read_dir("/proc/self/fd")
        .unwrap()
        .filter_map(|entry| fs::read_link(entry.unwrap().path()).ok())
        .filter(|entry| entry == path)
        .count()
}
#[test]
fn malformed_truncated_or_multiple_rights_close_every_installed_descriptor() {
    let path = std::env::temp_dir().join(format!(
        "engine-cmsg-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    for (count, payload) in [
        (1, vec![0]),
        (2, vec![71]),
        (16, vec![71]),
        (1, vec![71, 72]),
    ] {
        let (receiver, sender) = UnixDatagram::pair().unwrap();
        send(sender.as_raw_fd(), &vec![file.as_raw_fd(); count], &payload);
        assert!(receive_identity(receiver.as_raw_fd()).is_err());
        assert_eq!(references(&path), 1);
    }
    drop(file);
    fs::remove_file(path).unwrap();
}
#[test]
fn pre_exec_failure_after_identity_transfer_never_runs_the_controlled_program() {
    let mut handshake = Handshake::new().ok().unwrap();
    let mut command = Command::new(crate::engine_metadata::tests::program());
    handshake.configure(&mut command);
    // SAFETY: this fixed test-only pre_exec callback returns a raw errno without
    // allocation or host access, after the real private identity transfer.
    unsafe {
        command.pre_exec(|| Err(io::Error::from_raw_os_error(libc::EIO)));
    }
    assert!(command.spawn().is_err());
    let identity = handshake.receive().ok().unwrap();
    // Failed spawn already reaped its child; this handle still cannot refer to
    // an unrelated/reused PID, and no numeric signal fallback is attempted.
    assert_eq!(
        reap_status(&identity).unwrap_err().raw_os_error(),
        Some(libc::ECHILD)
    );
    close(identity).unwrap();
    handshake.finish().unwrap();
}
#[test]
fn preparation_finalizer_failure_closes_the_duplicate_and_preserves_uncertainty() {
    let path = std::env::temp_dir().join(format!(
        "engine-reserve-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    let fd: OwnedFd = file.into();
    let minimum = fd.as_raw_fd() + 1;
    let mut calls = 0;
    let result = reserve_descriptor(fd, minimum, |fd| {
        calls += 1;
        let result = close(fd);
        if calls == 1 {
            Err(io::Error::from_raw_os_error(libc::EIO))
        } else {
            result
        }
    });
    assert!(result.err().unwrap().close_failed);
    assert_eq!(calls, 2);
    assert_eq!(references(&path), 0);
    fs::remove_file(path).unwrap();
}
