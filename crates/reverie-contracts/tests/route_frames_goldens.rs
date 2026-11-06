//! Shared route-frames-v1 cases in fixtures/route-frames-v1/cases.json. The TS decoder test
//! (apps/web/test/rust-routes/frames.test.ts) reads the same file, so both readers agree on every
//! accepted frame and refuse every malformed one with the same code.
use reverie_contracts::route_frames_v1::{
    Body, Direction, Frame, HEADER_BYTES, Media, Observation, ROUTES, Reply, VERSION, read_frame,
};
use reverie_contracts::subscription_profiles_v1::Provider;
use serde_json::Value;

fn cases() -> Value {
    serde_json::from_str(include_str!("fixtures/route-frames-v1/cases.json")).expect("cases JSON")
}

fn direction(name: &str) -> Direction {
    match name {
        "to_handler" => Direction::ToHandler,
        "to_front" => Direction::ToFront,
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

fn provider(name: &str) -> Provider {
    match name {
        "anthropic" => Provider::Anthropic,
        "openai" => Provider::Openai,
        other => panic!("unknown provider {other}"),
    }
}

fn expected(expect: &Value) -> Frame {
    let body = match expect["kind"].as_str().expect("kind") {
        "request" => Body::Request {
            route: text(expect, "route"),
            json: hex(&text(expect, "json_hex")),
        },
        "response" => Body::Response {
            status: expect["status"].as_u64().expect("status") as u16,
            body: hex(&text(expect, "body_hex")),
        },
        "refusal" => Body::Refusal {
            code: text(expect, "code"),
        },
        "cancel" => Body::Cancel,
        "observe" => Body::Observe {
            observation: Observation::SubscriptionModes,
            providers: expect["providers"]
                .as_array()
                .expect("providers")
                .iter()
                .map(|name| provider(name.as_str().expect("provider")))
                .collect(),
        },
        "observed" => Body::Observed {
            observation: Observation::SubscriptionModes,
            json: hex(&text(expect, "json_hex")),
        },
        "typed_response" => Body::TypedResponse {
            media: match expect["media"].as_u64().expect("media") {
                1 => Media::ApplicationJsonUtf8,
                2 => Media::TextPlainUtf8,
                other => panic!("unknown media {other}"),
            },
            status: expect["status"].as_u64().expect("status") as u16,
            body: hex(&text(expect, "body_hex")),
        },
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
        let decoded = read_frame(&mut wire.as_slice(), direction(&text(case, "direction")));
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
        assert_eq!(frame.encode(), Ok(wire), "{name} re-encodes byte for byte");
    }
}

/// A frame of `kind` whose payload is `payload_len` bytes of a valid shape.
fn boundary(kind: u8, spec: &Value) -> Vec<u8> {
    let mut payload = match kind {
        1 => {
            let route_len = spec["route_len"].as_u64().expect("route_len") as usize;
            let mut payload = vec![route_len as u8];
            payload.resize(1 + route_len, b'R');
            payload.resize(
                payload.len() + spec["json_len"].as_u64().expect("json_len") as usize,
                b' ',
            );
            payload
        }
        2 => {
            let mut payload = 200u16.to_be_bytes().to_vec();
            payload.resize(
                2 + spec["body_len"].as_u64().expect("body_len") as usize,
                b' ',
            );
            payload
        }
        7 => {
            let mut payload = vec![1, 0, 200];
            payload.resize(
                3 + spec["body_len"].as_u64().expect("body_len") as usize,
                b' ',
            );
            payload
        }
        6 => {
            let mut payload = vec![1];
            payload.resize(
                1 + spec["json_len"].as_u64().expect("json_len") as usize,
                b' ',
            );
            payload
        }
        other => panic!("no boundary shape for kind {other}"),
    };
    let mut frame = vec![VERSION, kind];
    frame.extend_from_slice(&1u64.to_be_bytes());
    frame.extend_from_slice(&1u64.to_be_bytes());
    frame.append(&mut payload);
    assert!(frame.len() >= HEADER_BYTES);
    [&(frame.len() as u32).to_be_bytes()[..], &frame].concat()
}

#[test]
fn each_kind_maximum_is_accepted_and_one_more_byte_is_not() {
    let cases = cases();
    for (name, spec) in cases["boundaries"].as_object().expect("boundaries") {
        let kind = spec["kind"].as_u64().expect("kind") as u8;
        let wire = boundary(kind, spec);
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

#[test]
fn the_route_table_is_the_shared_one() {
    let cases = cases();
    let shared: Vec<(String, Vec<u64>, Vec<String>)> = cases["routes"]
        .as_array()
        .expect("routes")
        .iter()
        .map(|route| {
            let statuses = route["statuses"].as_array().expect("statuses");
            let types = match route.get("media") {
                Some(media) => media
                    .as_array()
                    .expect("media")
                    .iter()
                    .map(|media| media.as_str().expect("media").to_string())
                    .collect(),
                None => vec![text(route, "content_type")],
            };
            (
                text(route, "key"),
                statuses
                    .iter()
                    .map(|status| status.as_u64().expect("status"))
                    .collect(),
                types,
            )
        })
        .collect();
    let table: Vec<(String, Vec<u64>, Vec<String>)> = ROUTES
        .iter()
        .map(|route| {
            let types = match route.reply {
                Reply::Fixed(content_type) => vec![content_type.to_string()],
                Reply::Typed(media) => media
                    .iter()
                    .map(|media| media.content_type().to_string())
                    .collect(),
            };
            (
                route.key.to_string(),
                route
                    .statuses
                    .iter()
                    .map(|status| u64::from(*status))
                    .collect(),
                types,
            )
        })
        .collect();
    assert_eq!(table, shared);
}
