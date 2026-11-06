use super::conn::{ConnFault, ConnFrame, ConnTable, Received};
use super::*;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

fn frame(id: u64, body: Body) -> Frame {
    Frame {
        generation: 1,
        id,
        body,
    }
}

fn read(wire: &[u8], direction: Direction) -> Result<Option<Frame>, FrameError> {
    read_frame(&mut &wire[..], direction)
}

/// A hand-built frame: `length | version | kind | generation | id | payload`.
fn raw(version: u8, kind: u8, generation: u64, id: u64, payload: &[u8]) -> Vec<u8> {
    let length = (HEADER_BYTES + payload.len()) as u32;
    [
        &length.to_be_bytes()[..],
        &[version, kind],
        &generation.to_be_bytes(),
        &id.to_be_bytes(),
        payload,
    ]
    .concat()
}

fn loopback(port: u16) -> SocketFacts {
    SocketFacts {
        address: IpAddr::V4(Ipv4Addr::LOCALHOST),
        port,
    }
}

fn every_kind() -> Vec<(Frame, Direction)> {
    let open = Body::ConnOpen {
        listener: Listener::Main,
        peer: loopback(50000),
        local: loopback(3000),
        encrypted: false,
    };
    let open6 = Body::ConnOpen {
        listener: Listener::Bridge,
        peer: SocketFacts {
            address: IpAddr::V6(Ipv6Addr::new(0xfd00, 0, 0, 0, 0, 0, 0, 7)),
            port: 1,
        },
        local: SocketFacts {
            address: IpAddr::V6(Ipv6Addr::LOCALHOST),
            port: 3000,
        },
        encrypted: true,
    };
    vec![
        (
            frame(
                0,
                Body::BindRequest {
                    listener: Listener::Main,
                    tls: true,
                    port: 0,
                    host: "127.0.0.1".into(),
                },
            ),
            Direction::ToFront,
        ),
        (
            frame(
                0,
                Body::Bound {
                    listener: Listener::Main,
                    port: 41234,
                },
            ),
            Direction::ToTs,
        ),
        (
            frame(
                0,
                Body::BindFailed {
                    listener: Listener::Bridge,
                    errno: "EADDRINUSE".into(),
                    message: "address in use".into(),
                },
            ),
            Direction::ToTs,
        ),
        (
            frame(
                0,
                Body::Accepting {
                    listener: Listener::Main,
                },
            ),
            Direction::ToFront,
        ),
        (frame(0, Body::ServiceReady), Direction::ToFront),
        (
            frame(
                0,
                Body::Unbind {
                    listener: Listener::Bridge,
                },
            ),
            Direction::ToFront,
        ),
        (
            frame(
                0,
                Body::Shutdown {
                    signal: Signal::Term,
                },
            ),
            Direction::ToTs,
        ),
        (frame(1, open), Direction::ToTs),
        (frame(2, open6), Direction::ToTs),
        (
            frame(1, Body::Data(b"GET / HTTP/1.1\r\n".to_vec())),
            Direction::ToTs,
        ),
        (
            frame(1, Body::Data(vec![0; MAX_DATA_BYTES])),
            Direction::ToFront,
        ),
        (frame(1, Body::End), Direction::ToFront),
        (
            frame(1, Body::Abort(AbortReason::Generation)),
            Direction::ToTs,
        ),
        (frame(1, Body::Credit(u32::MAX)), Direction::ToFront),
    ]
}

#[test]
fn every_kind_round_trips_in_its_direction_and_only_there() {
    for (frame, direction) in every_kind() {
        let wire = frame.encode(direction).expect("encodes");
        assert_eq!(read(&wire, direction), Ok(Some(frame.clone())), "{frame:?}");
        let other = match direction {
            Direction::ToFront => Direction::ToTs,
            Direction::ToTs => Direction::ToFront,
        };
        let both = frame.body.kind().allows(other);
        assert_eq!(read(&wire, other).is_ok(), both, "{frame:?}");
    }
}

#[test]
fn identity_separates_lifecycle_and_connection_frames() {
    // Lifecycle frames carry id 0, connection frames a non-zero id, and generation is never 0.
    let accepting = raw(VERSION, 4, 1, 1, &[0]);
    assert_eq!(
        read(&accepting, Direction::ToFront),
        Err(FrameError::Identity)
    );
    let end = raw(VERSION, 18, 1, 0, &[]);
    assert_eq!(read(&end, Direction::ToFront), Err(FrameError::Identity));
    let generation = raw(VERSION, 18, 0, 1, &[]);
    assert_eq!(
        read(&generation, Direction::ToFront),
        Err(FrameError::Identity)
    );
}

#[test]
fn length_version_and_kind_refuse_before_the_payload() {
    assert_eq!(
        read(&raw(1, 18, 1, 1, &[]), Direction::ToTs),
        Err(FrameError::Version)
    );
    // 21 to 26 are reserved for phase 2b and are not kinds yet.
    for kind in [0, 8, 15, 21, 22, 23, 24, 25, 26, 255] {
        assert_eq!(
            read(&raw(VERSION, kind, 1, 1, &[0]), Direction::ToTs),
            Err(FrameError::Kind),
            "{kind}"
        );
    }
    // Wrong direction: TS never sends conn_open, the front never sends accepting.
    assert_eq!(
        read(&raw(VERSION, 16, 1, 1, &[0; 39]), Direction::ToFront),
        Err(FrameError::Kind)
    );
    assert_eq!(
        read(&raw(VERSION, 4, 1, 0, &[0]), Direction::ToTs),
        Err(FrameError::Kind)
    );
    // A length past the direction's largest frame is refused from the first four bytes.
    let huge = (Direction::ToTs.max_length() as u32 + 1).to_be_bytes();
    assert_eq!(read(&huge, Direction::ToTs), Err(FrameError::Length));
    assert_eq!(
        read(&[0, 0, 0, 17], Direction::ToTs),
        Err(FrameError::Length)
    );
}

#[test]
fn every_kind_refuses_one_byte_outside_its_lengths() {
    for kind in KINDS {
        let (min, max) = kind.lengths();
        let direction = if kind.allows(Direction::ToTs) {
            Direction::ToTs
        } else {
            Direction::ToFront
        };
        let id = u64::from(kind.is_connection());
        for length in [min - 1, max + 1] {
            if length < HEADER_BYTES {
                continue;
            }
            let wire = raw(VERSION, kind.byte(), 1, id, &vec![0; length - HEADER_BYTES]);
            assert_eq!(
                read(&wire, direction),
                Err(FrameError::Length),
                "{kind:?} {length}"
            );
        }
    }
}

/// Built from the design's field limits, not from `Kind::lengths`, so a wrong bound fails here.
#[test]
fn the_largest_designed_payloads_are_accepted() {
    let largest = [
        (
            frame(
                0,
                Body::BindRequest {
                    listener: Listener::Main,
                    tls: true,
                    port: 1,
                    host: "h".repeat(MAX_HOST_BYTES),
                },
            ),
            Direction::ToFront,
        ),
        (
            frame(
                0,
                Body::BindFailed {
                    listener: Listener::Main,
                    errno: "E".repeat(MAX_ERRNO_BYTES),
                    message: "m".repeat(MAX_MESSAGE_BYTES),
                },
            ),
            Direction::ToTs,
        ),
        (
            frame(1, Body::Data(vec![0; MAX_DATA_BYTES])),
            Direction::ToFront,
        ),
        (
            frame(1, Body::Data(vec![0; MAX_DATA_BYTES])),
            Direction::ToTs,
        ),
    ];
    for (frame, direction) in largest {
        let wire = frame.encode(direction).expect("largest frame encodes");
        assert_eq!(wire.len(), 4 + frame.body.kind().lengths().1, "{frame:?}");
    }
    // A host is at least one byte, so an empty one is short, not a bad payload.
    assert_eq!(
        read(
            &raw(VERSION, 1, 1, 0, &[0, 0, 0, 80, 0]),
            Direction::ToFront
        ),
        Err(FrameError::Length)
    );
}

#[test]
fn payloads_are_finite_and_checked() {
    let to_ts = Direction::ToTs;
    let to_front = Direction::ToFront;
    let cases: &[(Vec<u8>, Direction)] = &[
        // Listener 2, tls 2, a mislength host, invalid UTF-8 host.
        (raw(VERSION, 1, 1, 0, &[2, 0, 0, 80, 1, b'h']), to_front),
        (raw(VERSION, 1, 1, 0, &[0, 2, 0, 80, 1, b'h']), to_front),
        (raw(VERSION, 1, 1, 0, &[0, 0, 0, 80, 2, b'h']), to_front),
        (raw(VERSION, 1, 1, 0, &[0, 0, 0, 80, 1, 0xff]), to_front),
        // errno lowercase, empty, or longer than its bytes.
        (raw(VERSION, 3, 1, 0, &[0, 1, b'e']), to_ts),
        (raw(VERSION, 3, 1, 0, &[0, 0, b'x']), to_ts),
        (raw(VERSION, 3, 1, 0, &[0, 5, b'E']), to_ts),
        // Signal 0 and 4, abort reason 4, credit 0, encrypted 2, family 5, IPv4 padding not zero.
        (raw(VERSION, 7, 1, 0, &[0]), to_ts),
        (raw(VERSION, 7, 1, 0, &[4]), to_ts),
        (raw(VERSION, 19, 1, 1, &[4]), to_ts),
        (raw(VERSION, 20, 1, 1, &[0, 0, 0, 0]), to_ts),
        (
            raw(
                VERSION,
                16,
                1,
                1,
                &[[0, 4].as_slice(), &[0; 36], &[2]].concat(),
            ),
            to_ts,
        ),
        (
            raw(
                VERSION,
                16,
                1,
                1,
                &[[0, 5].as_slice(), &[0; 36], &[0]].concat(),
            ),
            to_ts,
        ),
        (
            raw(
                VERSION,
                16,
                1,
                1,
                &[[0, 4, 127, 0, 0, 1, 9].as_slice(), &[0; 31], &[0]].concat(),
            ),
            to_ts,
        ),
    ];
    for (wire, direction) in cases {
        assert_eq!(
            read(wire, *direction),
            Err(FrameError::Payload),
            "{wire:02x?}"
        );
    }
}

#[test]
fn a_truncated_frame_and_a_clean_end_differ() {
    let wire = frame(1, Body::End)
        .encode(Direction::ToTs)
        .expect("encodes");
    assert_eq!(read(&[], Direction::ToTs), Ok(None));
    assert_eq!(
        read(&wire[..wire.len() - 1], Direction::ToTs),
        Err(FrameError::Truncated)
    );
}

#[test]
fn half_closes_close_only_when_both_directions_end() {
    let mut front = ConnTable::new(4);
    let id = front.open_next().expect("room");
    assert_eq!(front.send(id, ConnFrame::End), Ok(true));
    assert_eq!(front.receive(id, ConnFrame::Data(5)), Ok(Received::Data(5)));
    assert_eq!(front.send(id, ConnFrame::Data(1)), Err(ConnFault::AfterEnd));
    assert_eq!(
        front.receive(id, ConnFrame::End),
        Ok(Received::Ended { closed: true })
    );
    assert_eq!(front.open_count(), 0);

    let mut ts = ConnTable::new(4);
    assert_eq!(ts.receive(1, ConnFrame::Open), Ok(Received::Opened));
    assert_eq!(
        ts.receive(1, ConnFrame::End),
        Ok(Received::Ended { closed: false })
    );
    assert_eq!(ts.receive(1, ConnFrame::Data(1)), Err(ConnFault::AfterEnd));
}

#[test]
fn crossed_aborts_and_late_frames_are_normal() {
    let mut ts = ConnTable::new(4);
    ts.receive(1, ConnFrame::Open).expect("opens");
    // TS destroys the socket while the front's reset is in flight: both send abort.
    assert_eq!(ts.send(1, ConnFrame::Abort), Ok(true));
    assert_eq!(
        ts.receive(1, ConnFrame::Abort),
        Ok(Received::Late { data: 0 })
    );
    // Data and credit already on the wire are settled and dropped.
    assert_eq!(
        ts.receive(1, ConnFrame::Data(700)),
        Ok(Received::Late { data: 700 })
    );
    assert_eq!(
        ts.receive(1, ConnFrame::Credit(9)),
        Ok(Received::Late { data: 0 })
    );
    // A send for the closed id is skipped, not a fault.
    assert_eq!(ts.send(1, ConnFrame::Abort), Ok(false));
    assert_eq!(ts.send(1, ConnFrame::Data(1)), Ok(false));
}

#[test]
fn ids_are_monotone_and_never_reused() {
    let mut ts = ConnTable::new(4);
    assert_eq!(ts.receive(2, ConnFrame::Open), Err(ConnFault::Unopened));
    ts.receive(1, ConnFrame::Open).expect("opens");
    assert_eq!(ts.receive(1, ConnFrame::Open), Err(ConnFault::Unopened));
    assert_eq!(ts.receive(5, ConnFrame::Data(1)), Err(ConnFault::Unopened));
    assert_eq!(ts.send(5, ConnFrame::End), Err(ConnFault::Unopened));
    ts.receive(1, ConnFrame::Abort).expect("aborts");
    assert_eq!(ts.receive(1, ConnFrame::Open), Err(ConnFault::Unopened));
    assert_eq!(ts.receive(2, ConnFrame::Open), Ok(Received::Opened));
}

#[test]
fn the_connection_bound_holds_on_both_sides() {
    let mut front = ConnTable::new(2);
    let first = front.open_next().expect("room");
    front.open_next().expect("room");
    assert_eq!(front.open_next(), Err(ConnFault::Full));
    front.send(first, ConnFrame::Abort).expect("aborts");
    assert_eq!(front.open_next(), Ok(3));

    let mut ts = ConnTable::new(1);
    ts.receive(1, ConnFrame::Open).expect("opens");
    assert_eq!(ts.receive(2, ConnFrame::Open), Err(ConnFault::Full));
}
