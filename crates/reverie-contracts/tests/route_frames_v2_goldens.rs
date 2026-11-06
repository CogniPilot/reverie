//! Shared route-frames-v2 cases in fixtures/route-frames-v2/cases.json. The TS reader test
//! (apps/web/test/rust-front/frames.test.ts) reads the same file, so both readers agree on every
//! accepted frame, refuse every malformed one with the same code, and apply the same connection rules.
use reverie_contracts::route_frames_v2::conn::{ConnFrame, ConnTable, Received};
use reverie_contracts::route_frames_v2::{
    AbortReason, Body, Direction, Frame, HEADER_BYTES, Listener, Signal, SocketFacts, VERSION,
    read_frame,
};
use serde_json::Value;

fn cases() -> Value {
    serde_json::from_str(include_str!("fixtures/route-frames-v2/cases.json")).expect("cases JSON")
}

fn direction(name: &str) -> Direction {
    match name {
        "to_front" => Direction::ToFront,
        "to_ts" => Direction::ToTs,
        other => panic!("unknown direction {other}"),
    }
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("hex"))
        .collect()
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().expect(key).to_string()
}

fn number(value: &Value, key: &str) -> u64 {
    value[key].as_u64().expect(key)
}

fn flag(value: &Value, key: &str) -> bool {
    value[key].as_bool().expect(key)
}

fn listener(value: &Value) -> Listener {
    match value["listener"].as_str().expect("listener") {
        "main" => Listener::Main,
        "bridge" => Listener::Bridge,
        other => panic!("unknown listener {other}"),
    }
}

fn facts(value: &Value) -> SocketFacts {
    SocketFacts {
        address: text(value, "address").parse().expect("address"),
        port: number(value, "port") as u16,
    }
}

fn expected(expect: &Value) -> Frame {
    let body = match expect["kind"].as_str().expect("kind") {
        "bind_request" => Body::BindRequest {
            listener: listener(expect),
            tls: flag(expect, "tls"),
            port: number(expect, "port") as u16,
            host: text(expect, "host"),
        },
        "bound" => Body::Bound {
            listener: listener(expect),
            port: number(expect, "port") as u16,
        },
        "bind_failed" => Body::BindFailed {
            listener: listener(expect),
            errno: text(expect, "errno"),
            message: text(expect, "message"),
        },
        "accepting" => Body::Accepting {
            listener: listener(expect),
        },
        "service_ready" => Body::ServiceReady,
        "unbind" => Body::Unbind {
            listener: listener(expect),
        },
        "shutdown" => Body::Shutdown {
            signal: match expect["signal"].as_str().expect("signal") {
                "SIGTERM" => Signal::Term,
                "SIGINT" => Signal::Int,
                "SIGHUP" => Signal::Hup,
                other => panic!("unknown signal {other}"),
            },
        },
        "conn_open" => Body::ConnOpen {
            listener: listener(expect),
            peer: facts(&expect["peer"]),
            local: facts(&expect["local"]),
            encrypted: flag(expect, "encrypted"),
        },
        "data" => Body::Data(hex(&text(expect, "bytes_hex"))),
        "end" => Body::End,
        "abort" => Body::Abort(match expect["reason"].as_str().expect("reason") {
            "peer_reset" => AbortReason::PeerReset,
            "destroy" => AbortReason::Destroy,
            "timeout" => AbortReason::Timeout,
            "generation" => AbortReason::Generation,
            other => panic!("unknown reason {other}"),
        }),
        "credit" => Body::Credit(number(expect, "bytes") as u32),
        other => panic!("unknown kind {other}"),
    };
    // Decimal strings: a JSON number cannot carry every u64 through every reader.
    Frame {
        generation: text(expect, "generation").parse().expect("generation"),
        id: text(expect, "id").parse().expect("id"),
        body,
    }
}

#[test]
fn rust_reader_agrees_with_every_shared_case() {
    let cases = cases();
    for case in cases["cases"].as_array().expect("cases") {
        let name = text(case, "name");
        let wire = hex(&text(case, "hex"));
        let direction = direction(&text(case, "direction"));
        let decoded = read_frame(&mut wire.as_slice(), direction);
        if let Some(error) = case.get("error") {
            assert_eq!(
                decoded.map_err(|error| error.code()),
                Err(error.as_str().expect("error")),
                "{name}"
            );
            continue;
        }
        let frame = expected(&case["expect"]);
        assert_eq!(decoded, Ok(Some(frame.clone())), "{name}");
        assert_eq!(
            frame.encode(direction),
            Ok(wire),
            "{name} re-encodes byte for byte"
        );
    }
}

#[test]
fn the_direction_maxima_are_the_shared_ones() {
    let cases = cases();
    for name in ["to_front", "to_ts"] {
        assert_eq!(
            direction(name).max_length() as u64,
            number(&cases["max_lengths"], name),
            "{name}"
        );
    }
}

/// A frame of `kind` whose fields have the lengths `spec` gives, in an otherwise valid shape.
fn boundary(kind: u8, spec: &Value) -> Vec<u8> {
    let len = |key: &str| number(spec, key) as usize;
    let (id, payload) = match kind {
        1 => {
            let host = len("host_len");
            let mut payload = vec![0, 0, 0, 80, host as u8];
            payload.resize(5 + host, b'h');
            (0, payload)
        }
        3 => {
            let (errno, message) = (len("errno_len"), len("message_len"));
            let mut payload = vec![0, errno as u8];
            payload.resize(2 + errno, b'E');
            payload.resize(2 + errno + message, b'm');
            (0, payload)
        }
        17 => (1, vec![0xab; len("data_len")]),
        other => panic!("no boundary shape for kind {other}"),
    };
    let frame = [
        &[VERSION, kind][..],
        &1u64.to_be_bytes(),
        &u64::to_be_bytes(id),
        &payload,
    ]
    .concat();
    assert!(frame.len() >= HEADER_BYTES);
    [&(frame.len() as u32).to_be_bytes()[..], &frame].concat()
}

#[test]
fn each_field_limit_is_accepted_and_one_more_byte_is_not() {
    let cases = cases();
    for (name, spec) in cases["boundaries"].as_object().expect("boundaries") {
        let wire = boundary(number(spec, "kind") as u8, spec);
        let decoded = read_frame(&mut wire.as_slice(), direction(&text(spec, "direction")));
        match spec.get("error") {
            Some(error) => assert_eq!(
                decoded.map_err(|error| error.code()),
                Err(error.as_str().expect("error")),
                "{name}"
            ),
            None => assert!(matches!(decoded, Ok(Some(_))), "{name}: {decoded:?}"),
        }
    }
}

fn conn_frame(frame: &Value) -> ConnFrame {
    match frame["kind"].as_str().expect("kind") {
        "open" => ConnFrame::Open,
        "data" => ConnFrame::Data(number(frame, "bytes") as usize),
        "end" => ConnFrame::End,
        "abort" => ConnFrame::Abort,
        "credit" => ConnFrame::Credit(number(frame, "bytes") as u32),
        other => panic!("unknown connection frame {other}"),
    }
}

fn received(expect: &Value) -> Received {
    match expect["received"].as_str().expect("received") {
        "opened" => Received::Opened,
        "data" => Received::Data(number(expect, "bytes") as usize),
        "ended" => Received::Ended {
            closed: flag(expect, "closed"),
        },
        "aborted" => Received::Aborted,
        "credit" => Received::Credit(number(expect, "bytes") as u32),
        "late" => Received::Late {
            data: number(expect, "data") as usize,
        },
        other => panic!("unknown outcome {other}"),
    }
}

#[test]
fn the_connection_rules_run_every_shared_sequence() {
    let cases = cases();
    for sequence in cases["conn"].as_array().expect("conn") {
        let name = text(sequence, "name");
        let mut table = ConnTable::new(number(sequence, "max_open") as usize);
        for (at, step) in sequence["steps"]
            .as_array()
            .expect("steps")
            .iter()
            .enumerate()
        {
            let label = format!("{name} step {at}");
            let error = step.get("error").map(|code| code.as_str().expect("error"));
            match step["op"].as_str().expect("op") {
                "open_next" => {
                    let outcome = table.open_next().map_err(|fault| fault.code());
                    match error {
                        Some(code) => assert_eq!(outcome, Err(code), "{label}"),
                        None => assert_eq!(outcome, Ok(number(step, "expect")), "{label}"),
                    }
                }
                "receive" => {
                    let outcome = table
                        .receive(number(step, "id"), conn_frame(&step["frame"]))
                        .map_err(|fault| fault.code());
                    match error {
                        Some(code) => assert_eq!(outcome, Err(code), "{label}"),
                        None => assert_eq!(outcome, Ok(received(&step["expect"])), "{label}"),
                    }
                }
                "send" => {
                    let outcome = table
                        .send(number(step, "id"), conn_frame(&step["frame"]))
                        .map_err(|fault| fault.code());
                    match error {
                        Some(code) => assert_eq!(outcome, Err(code), "{label}"),
                        None => assert_eq!(outcome, Ok(flag(step, "expect")), "{label}"),
                    }
                }
                other => panic!("unknown op {other}"),
            }
        }
        assert_eq!(
            table.open_count() as u64,
            number(sequence, "open_count"),
            "{name}"
        );
    }
}
