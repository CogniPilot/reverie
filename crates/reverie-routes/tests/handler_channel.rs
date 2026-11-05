//! The handler's frame state machine, in process and through the real `reverie-route-handler` binary.
use reverie_contracts::route_frames_v1::{
    Body, Direction, Frame, Observation, SUBSCRIPTION_PROFILES, read_frame,
};
use reverie_contracts::subscription_profiles_v1::Provider;
use reverie_routes::channel::{CANCELED, Fatal, UNKNOWN_ROUTE, serve};
use serde_json::{Value, json};
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const GENERATION: u64 = 7;

fn frame(id: u64, body: Body) -> Vec<u8> {
    Frame {
        generation: GENERATION,
        id,
        body,
    }
    .encode()
    .expect("valid frame")
}

fn request(id: u64, json: &Value) -> Vec<u8> {
    frame(
        id,
        Body::Request {
            route: SUBSCRIPTION_PROFILES.to_string(),
            json: serde_json::to_vec(json).expect("request JSON"),
        },
    )
}

fn observed(id: u64, json: &[u8]) -> Vec<u8> {
    frame(
        id,
        Body::Observed {
            observation: Observation::SubscriptionModes,
            json: json.to_vec(),
        },
    )
}

/// Every frame the handler wrote, in order.
fn replies(mut output: &[u8]) -> Vec<Frame> {
    let mut frames = Vec::new();
    while let Some(frame) = read_frame(&mut output, Direction::ToFront).expect("handler frame") {
        assert_eq!(frame.generation, GENERATION);
        frames.push(frame);
    }
    frames
}

fn run(input: &[Vec<u8>]) -> (Result<(), Fatal>, Vec<Frame>) {
    let input = input.concat();
    let mut output = Vec::new();
    let outcome = serve(GENERATION, &mut input.as_slice(), &mut output);
    (outcome, replies(&output))
}

fn refusal(id: u64, code: &str) -> Frame {
    Frame {
        generation: GENERATION,
        id,
        body: Body::Refusal {
            code: code.to_string(),
        },
    }
}

/// A root this test created; an existing name is never adopted.
fn temp_root(label: &str) -> PathBuf {
    for attempt in 0..100 {
        let root = std::env::temp_dir().join(format!(
            "route-channel-{}-{label}-{attempt}",
            std::process::id()
        ));
        match fs::create_dir(&root) {
            Ok(()) => {
                fs::create_dir(root.join("home")).expect("home");
                fs::create_dir(root.join("data")).expect("data");
                return root;
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => panic!("temp root: {error}"),
        }
    }
    panic!("no unused temp root name");
}

fn profiles_request(root: &Path) -> Value {
    let root = root.to_str().expect("UTF-8 temp root");
    json!({
        "env": {},
        "home": format!("{root}/home"),
        "cwd": root,
        "platform": std::env::consts::OS,
        "dataDir": format!("{root}/data"),
    })
}

const ONE_PROFILE: &str = r#"[{"id": "p0", "label": "Plan 0", "provider": "anthropic", "configDir": "/accounts/p0", "openCodeDataDir": "/accounts/p0/opencode-data"}]"#;

#[test]
fn end_of_input_while_idle_is_clean() {
    assert_eq!(run(&[]), (Ok(()), Vec::new()));
}

#[test]
fn idle_accepts_only_the_next_request_or_a_late_cancel() {
    let unknown = frame(
        1,
        Body::Request {
            route: "GET /api/elsewhere".to_string(),
            json: b"{}".to_vec(),
        },
    );
    let (outcome, frames) = run(&[
        unknown.clone(),
        frame(1, Body::Cancel),
        request(2, &json!({"extra": 1})),
    ]);
    assert_eq!(outcome, Ok(()));
    assert_eq!(
        frames,
        [refusal(1, UNKNOWN_ROUTE), refusal(2, "REQUEST_SCHEMA")]
    );

    assert_eq!(run(&[request(2, &json!({}))]).0, Err(Fatal::Sequence));
    assert_eq!(run(&[unknown.clone(), unknown]).0, Err(Fatal::Sequence));
    assert_eq!(run(&[frame(1, Body::Cancel)]).0, Err(Fatal::Sequence));
    let foreign = Frame {
        generation: GENERATION + 1,
        id: 1,
        body: Body::Cancel,
    };
    assert_eq!(
        run(&[foreign.encode().expect("frame")]).0,
        Err(Fatal::Generation)
    );
}

#[test]
fn no_profiles_is_answered_without_an_observation() {
    let root = temp_root("none");
    let (outcome, frames) = run(&[request(1, &profiles_request(&root))]);
    fs::remove_dir_all(&root).expect("cleanup");
    assert_eq!(outcome, Ok(()));
    assert_eq!(
        frames,
        [Frame {
            generation: GENERATION,
            id: 1,
            body: Body::Response {
                status: 200,
                body: br#"{"success":true,"data":{"profiles":[]}}"#.to_vec(),
            },
        }]
    );
}

#[test]
fn profiles_ask_for_their_providers_modes_then_answer_once() {
    let root = temp_root("one");
    fs::write(root.join("data/subscription-profiles.json"), ONE_PROFILE).expect("profiles");
    let ask = Frame {
        generation: GENERATION,
        id: 1,
        body: Body::Observe {
            observation: Observation::SubscriptionModes,
            providers: vec![Provider::Anthropic],
        },
    };
    let read = request(1, &profiles_request(&root));
    let answered = run(&[read.clone(), observed(1, br#"{"anthropic":["claude"]}"#)]);
    let canceled = run(&[read.clone(), frame(1, Body::Cancel)]);
    let malformed = run(&[read.clone(), observed(1, br#"{"openai":[]}"#)]);
    let abandoned = run(std::slice::from_ref(&read));
    let interrupted = run(&[read, request(2, &json!({}))]);
    fs::remove_dir_all(&root).expect("cleanup");

    let (outcome, frames) = answered;
    assert_eq!(outcome, Ok(()));
    assert_eq!(frames[0], ask);
    let Body::Response { status, body } = &frames[1].body else {
        panic!("expected a response, got {:?}", frames[1]);
    };
    assert_eq!(*status, 200);
    assert!(
        String::from_utf8_lossy(body).contains(r#""modes":["claude"]"#),
        "{}",
        String::from_utf8_lossy(body)
    );
    assert_eq!(frames.len(), 2);

    assert_eq!(canceled, (Ok(()), vec![ask.clone(), refusal(1, CANCELED)]));
    assert_eq!(
        malformed,
        (Ok(()), vec![ask.clone(), refusal(1, "OBSERVATION_SCHEMA")])
    );
    assert_eq!(abandoned, (Err(Fatal::Abandoned), vec![ask.clone()]));
    assert_eq!(interrupted, (Err(Fatal::Sequence), vec![ask]));
}

fn handler(arguments: &[&str], input: &[u8]) -> (Option<i32>, Vec<u8>, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_reverie-route-handler"))
        .args(arguments)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("handler starts");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(input)
        .expect("write frames");
    let output = child.wait_with_output().expect("handler exits");
    (
        output.status.code(),
        output.stdout,
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[test]
fn the_binary_speaks_only_frames_and_exits_by_its_contract() {
    let unknown = Frame {
        generation: GENERATION,
        id: 1,
        body: Body::Request {
            route: "GET /api/elsewhere".to_string(),
            json: b"{}".to_vec(),
        },
    };
    let generation = GENERATION.to_string();
    let (code, stdout, stderr) = handler(
        &["--generation", &generation],
        &unknown.encode().expect("frame"),
    );
    assert_eq!(code, Some(0));
    assert_eq!(replies(&stdout), [refusal(1, UNKNOWN_ROUTE)]);
    assert_eq!(stderr, "");

    let (code, stdout, stderr) = handler(&["--generation", &generation], &[0, 0, 0, 1]);
    assert_eq!(code, Some(2));
    assert!(stdout.is_empty());
    assert_eq!(stderr, "reverie-route-handler: FRAME_LENGTH\n");

    let refused: [&[&str]; 3] = [&[], &["--generation", "0"], &["--generation", "7", "x"]];
    for arguments in refused {
        let (code, stdout, _) = handler(arguments, &[]);
        assert_eq!(code, Some(2), "{arguments:?}");
        assert!(stdout.is_empty());
    }
}

#[test]
fn the_handler_source_starts_no_process() {
    fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).expect("source dir") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                sources(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }
    let mut files = Vec::new();
    sources(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut files,
    );
    assert!(!files.is_empty());
    for path in files {
        let source = fs::read_to_string(&path).expect("source");
        for spawning in ["Command", "process::Child", ".spawn(", "libc::fork", "exec"] {
            assert!(
                !source.contains(spawning),
                "{} mentions {spawning}",
                path.display()
            );
        }
    }
}
