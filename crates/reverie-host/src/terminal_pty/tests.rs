use super::*;
use nix::fcntl::{FcntlArg, FdFlag, fcntl};
fn dimensions(cols: u16, rows: u16) -> TerminalSize {
    TerminalSize::try_new(cols, rows).unwrap()
}
fn read_master_exact(pair: &OwnedPty, output: &mut [u8]) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let mut filled = 0;
    while filled < output.len() {
        assert!(
            std::time::Instant::now() < deadline,
            "owned PTY read deadline"
        );
        match pair.try_read(&mut output[filled..]) {
            Ok(0) => panic!("unexpected PTY EOF"),
            Ok(size) => filled += size,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => panic!("owned PTY read: {error}"),
        }
    }
}
#[test]
fn raw_pair_has_atomic_cloexec_and_independent_master_slave_status_flags() {
    let pair = OwnedPty::open(dimensions(83, 27)).unwrap();
    for fd in [pair.as_fd(), pair.slave_fd().unwrap()] {
        assert_ne!(
            fcntl(fd, FcntlArg::F_GETFD).unwrap() & FdFlag::FD_CLOEXEC.bits(),
            0
        );
    }
    let master = OFlag::from_bits_retain(fcntl(pair.as_fd(), FcntlArg::F_GETFL).unwrap());
    let slave =
        OFlag::from_bits_retain(fcntl(pair.slave_fd().unwrap(), FcntlArg::F_GETFL).unwrap());
    assert!(master.contains(OFlag::O_NONBLOCK));
    assert!(!slave.contains(OFlag::O_NONBLOCK));
    let window = native::window(pair.slave_fd().unwrap()).unwrap();
    assert_eq!(
        (
            window.ws_col,
            window.ws_row,
            window.ws_xpixel,
            window.ws_ypixel
        ),
        (83, 27, 0, 0)
    );
    pair.close().unwrap();
}
#[test]
fn raw_binary_io_and_resizing_preserve_all_bytes_without_echo_or_translation() {
    let pair = OwnedPty::open(dimensions(80, 24)).unwrap();
    let bytes = [0, 3, b'\r', b'\n', 127, 128, 255];
    assert_eq!(pair.try_write(&bytes).unwrap(), bytes.len());
    let mut received = [0; 7];
    pair.slave
        .as_ref()
        .unwrap()
        .read_exact(&mut received)
        .unwrap();
    assert_eq!(received, bytes);
    assert_eq!(
        pair.try_read(&mut [0; 32]).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
    pair.slave.as_ref().unwrap().write_all(&bytes).unwrap();
    let mut output = [0; 7];
    // A nonblocking master may need another readiness turn even after the
    // slave accepted its bytes; neither chunk size nor immediate readiness is promised.
    read_master_exact(&pair, &mut output);
    assert_eq!(output, bytes);
    pair.resize(dimensions(101, 33)).unwrap();
    let window = native::window(pair.slave_fd().unwrap()).unwrap();
    assert_eq!((window.ws_col, window.ws_row), (101, 33));
    pair.close().unwrap();
}
#[test]
fn checked_slave_close_is_idempotent_and_master_reports_hangup_without_fabricating_bytes() {
    if crate::test_process::isolate_case(
        "terminal_pty::tests::checked_slave_close_is_idempotent_and_master_reports_hangup_without_fabricating_bytes",
    ) {
        return;
    }
    let mut pair = OwnedPty::open(dimensions(80, 24)).unwrap();
    pair.close_slave().unwrap();
    pair.close_slave().unwrap();
    assert_eq!(
        pair.slave_fd().unwrap_err().kind(),
        io::ErrorKind::NotConnected
    );
    assert_eq!(
        pair.try_read(&mut [0; 1]).unwrap_err().raw_os_error(),
        Some(libc::EIO)
    );
    pair.close().unwrap();
}
#[test]
fn actual_slave_close_failure_latches_uncertainty_and_is_never_retried() {
    if crate::test_process::isolate_case(
        "terminal_pty::tests::actual_slave_close_failure_latches_uncertainty_and_is_never_retried",
    ) {
        return;
    }
    let mut pair = OwnedPty::open(dimensions(80, 24)).unwrap();
    let guard = test_hooks::faults(false, false, true);
    let failure = pair.close_slave().unwrap_err();
    assert!(failure.close_uncertain());
    // EIO proves the peer really closed before the injected acknowledgement loss.
    assert_eq!(
        pair.try_read(&mut [0; 1]).unwrap_err().raw_os_error(),
        Some(libc::EIO)
    );
    assert!(pair.close_slave().unwrap_err().close_uncertain());
    assert_eq!(test_hooks::closes(), (0, 1));
    drop(guard);
    let failure = pair.close().unwrap_err();
    assert!(failure.close_uncertain());
    assert!(failure.prior_close);
}
#[test]
fn partial_preparation_preserves_primary_and_both_actual_close_failures() {
    let _guard = test_hooks::faults(true, true, true);
    let failure = match OwnedPty::open(dimensions(80, 24)) {
        Err(error) => error,
        Ok(pair) => {
            let _ = pair.close();
            panic!("preparation incorrectly succeeded");
        }
    };
    assert!(
        failure
            .primary
            .as_ref()
            .unwrap()
            .to_string()
            .contains("preparation failure")
    );
    assert!(failure.master_close.is_some());
    assert!(failure.slave_close.is_some());
    assert!(failure.close_uncertain());
    assert_eq!(test_hooks::closes(), (1, 1));
}
#[test]
fn raw_mode_matches_actual_python_owned_pty_vectors_including_software_flow_flags() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!("legacy_raw.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let pair = OwnedPty::open(dimensions(80, 24)).unwrap();
        let mut mode = termios::tcgetattr(pair.slave_fd().unwrap()).unwrap();
        let flags = case["before"]["flags"].as_array().unwrap();
        mode.input_flags =
            InputFlags::from_bits_retain(flags[0].as_u64().unwrap() as libc::tcflag_t);
        mode.output_flags =
            OutputFlags::from_bits_retain(flags[1].as_u64().unwrap() as libc::tcflag_t);
        mode.control_flags =
            ControlFlags::from_bits_retain(flags[2].as_u64().unwrap() as libc::tcflag_t);
        mode.local_flags =
            LocalFlags::from_bits_retain(flags[3].as_u64().unwrap() as libc::tcflag_t);
        let before = case["before"]["cc"].as_array().unwrap();
        for (destination, value) in mode.control_chars.iter_mut().zip(before) {
            *destination = value.as_u64().unwrap() as u8;
        }
        let speeds = (termios::cfgetispeed(&mode), termios::cfgetospeed(&mode));
        python_raw(&mut mode);
        let expected = case["after"]["flags"].as_array().unwrap();
        let actual = [
            mode.input_flags.bits(),
            mode.output_flags.bits(),
            mode.control_flags.bits(),
            mode.local_flags.bits(),
        ];
        let expected: Vec<_> = expected
            .iter()
            .map(|value| value.as_u64().unwrap() as libc::tcflag_t)
            .collect();
        assert_eq!(actual.as_slice(), expected, "{}", case["name"]);
        let cc: Vec<_> = case["after"]["cc"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_u64().unwrap() as u8)
            .collect();
        assert_eq!(mode.control_chars.as_slice(), cc);
        assert_eq!(
            (termios::cfgetispeed(&mode), termios::cfgetospeed(&mode)),
            speeds
        );
        pair.close().unwrap();
    }
}
