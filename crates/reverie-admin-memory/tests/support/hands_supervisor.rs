use super::{Fixture, ROOM, SESSION, SOURCE};
#[path = "hands_coding.rs"]
mod coding;
use nix::{
    fcntl::{Flock, FlockArg},
    pty::{Winsize, openpty},
    sys::{
        signal::{Signal, kill},
        termios::{LocalFlags, tcgetattr},
    },
    unistd::Pid,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    os::unix::process::CommandExt,
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

fn configure(fixture: &Fixture, model: &TcpListener) -> Command {
    fixture.write(
        "agent.json",
        &json!({
            "rooms":"auto","self_session_id":SESSION,"self_name":"Fixture",
            "state_file":fixture.0.join("state.json"),"model":"fixture",
            "api_base":format!("http://{}/v1",model.local_addr().unwrap()),
            "model_timeout_s":10,"cli_timeout_s":3,"poll_s":2,
            "timezone":"UTC","turn_trace_file":fixture.0.join("trace.jsonl"),
            "cli":[env!("CARGO_BIN_EXE_reverie-room-fixture"),fixture.0]
        }),
    );
    fixture.write(
        "state.json",
        &json!({
            "_auto_rooms":[ROOM],ROOM:{"since":1,"seen":[],"claims":{},"last_id":"previous"},
            "_coding_epoch":7,"_coding":{"prior":{"status":"started","record":"preserve"}},
        }),
    );
    let mut command = Command::new(env!("CARGO_BIN_EXE_reverie-admin-memory"));
    command
        .arg("--hands-native")
        .arg(fixture.0.join("agent.json"))
        .env("NO_PROXY", "127.0.0.1")
        .env("no_proxy", "127.0.0.1")
        .env("TERM", "xterm");
    command
}

fn listener() -> TcpListener {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    listener
}

#[test]
fn native_supervisor_refuses_a_second_writer_for_the_same_state() {
    let fixture = Fixture::new();
    let model = listener();
    let mut command = configure(&fixture, &model);
    let state = fs::read(fixture.0.join("state.json")).unwrap();
    let lock = fs::File::create(fixture.0.join("state.run.lock")).unwrap();
    let _owner = Flock::lock(lock, FlockArg::LockExclusiveNonblock).unwrap();
    let output = command.arg("--once").output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Hands is already running"));
    assert_eq!(fs::read(fixture.0.join("state.json")).unwrap(), state);
}

fn accept(listener: &TcpListener, child: &mut Child) -> TcpStream {
    let until = Instant::now() + Duration::from_secs(8);
    let stream = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < until =>
            {
                assert!(
                    child.try_wait().unwrap().is_none(),
                    "native Hands exited before connecting to the model"
                );
                thread::sleep(Duration::from_millis(5));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("model connection missing: {error}");
            }
        }
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream
}

fn request(stream: &TcpStream) -> Value {
    let mut buffer = BufReader::new(stream);
    let mut length = None;
    loop {
        let mut line = String::new();
        assert_ne!(buffer.read_line(&mut line).unwrap(), 0);
        if line == "\r\n" {
            break;
        }
        if let Some((key, value)) = line.split_once(':')
            && key.eq_ignore_ascii_case("content-length")
        {
            length = Some(value.trim().parse::<usize>().unwrap());
        }
    }
    let mut body = vec![0; length.unwrap()];
    buffer.read_exact(&mut body).unwrap();
    serde_json::from_slice(&body).unwrap()
}

fn wait(child: &mut Child) -> ExitStatus {
    let until = Instant::now() + Duration::from_secs(7);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() >= until {
            let _ = child.kill();
            let _ = child.wait();
            panic!("native Hands did not exit");
        }
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn native_hands_runs_the_workers_and_preserves_existing_coding_receipts() {
    let fixture = Fixture::new();
    let listener = listener();
    let mut child = configure(&fixture, &listener)
        .args(["--once", "--no-tui"])
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let mut socket = accept(&listener, &mut child);
    let input = request(&socket);
    assert!(
        input["messages"][1]["content"]
            .as_str()
            .unwrap()
            .contains("hello")
    );
    assert_eq!(fixture.saved()[ROOM]["claims"][SOURCE]["tries"], 1);
    let content =
        json!({"choices":[{"message":{"content":"A native reply."},"finish_reason":"stop"}]})
            .to_string();
    write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{content}",content.len()).unwrap();
    assert!(wait(&mut child).success());
    let post: Vec<String> =
        serde_json::from_slice(&fs::read(fixture.0.join("post.json")).unwrap()).unwrap();
    assert_eq!(
        post,
        [
            "say",
            "--room",
            ROOM,
            "--json",
            "--reply-to",
            SOURCE,
            "--",
            "A native reply."
        ]
    );
    let saved = fixture.saved();
    assert_eq!(saved[ROOM]["claims"], json!({}));
    assert_eq!(saved[ROOM]["seen"], json!([SOURCE]));
    assert_eq!(saved["_coding_epoch"], 7);
    assert_eq!(
        saved["_coding"]["prior"],
        json!({"status":"stopped","reason":"interrupted","record":"preserve"})
    );
    let trace: Value =
        serde_json::from_slice(&fs::read(fixture.0.join("trace.jsonl")).unwrap()).unwrap();
    assert_eq!(trace["msg"], SOURCE);
    assert_eq!(trace["steps"][0]["outcome"], "answer");
    assert!(!trace.to_string().contains("A native reply."));
}

#[test]
fn native_hands_interrupts_an_inflight_turn_and_restores_the_terminal() {
    let fixture = Fixture::new();
    let listener = listener();
    let size = Winsize {
        ws_row: 24,
        ws_col: 80,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let pty = openpty(Some(&size), None).unwrap();
    let original = tcgetattr(&pty.slave).unwrap();
    let mut child = configure(&fixture, &listener)
        .process_group(0)
        .stdin(Stdio::from(pty.slave.try_clone().unwrap()))
        .stdout(Stdio::from(pty.slave.try_clone().unwrap()))
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let socket = accept(&listener, &mut child);
    let _ = request(&socket);
    let active = tcgetattr(&pty.slave).unwrap();
    kill(
        Pid::from_raw(i32::try_from(child.id()).unwrap()),
        Signal::SIGINT,
    )
    .unwrap();
    assert!(wait(&mut child).success());
    assert!(!active.local_flags.contains(LocalFlags::ICANON));
    assert_eq!(tcgetattr(&pty.slave).unwrap(), original);
    assert_eq!(fixture.saved()[ROOM]["claims"][SOURCE]["tries"], 1);
    assert!(!fixture.0.join("post.json").exists());
}

#[test]
fn native_hands_scans_immediately_for_a_scoped_phone_notification() {
    const NEW: &str = "30000000-0000-4000-8000-000000000009";
    let fixture = Fixture::new();
    let model = listener();
    let phone = listener();
    let mut command = configure(&fixture, &model);
    let mut config: Value =
        serde_json::from_slice(&fs::read(fixture.0.join("agent.json")).unwrap()).unwrap();
    config["poll_s"] = json!(30);
    config["phone_wake"] = json!(true);
    fixture.write("agent.json", &config);
    let mut saved = fixture.saved();
    saved[ROOM]["last_id"] = json!(SOURCE);
    saved[ROOM]["seen"] = json!([SOURCE]);
    fixture.write("state.json", &saved);
    let mut child = command
        .arg("--no-tui")
        .env("REVERIE_WORKER", "1")
        .env("REVERIE_SESSION_ID", SESSION)
        .env(
            "REVERIE_API_URL",
            format!("http://{}", phone.local_addr().unwrap()),
        )
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let mut phone = accept(&phone, &mut child);
    let mut line = String::new();
    BufReader::new(&phone).read_line(&mut line).unwrap();
    assert_eq!(line, "GET /api/chatrooms/attention HTTP/1.1\r\n");
    wait_for_first_listing(&fixture);
    let message = json!({"id":NEW,"at":11,"roomId":ROOM,"from":{"kind":"user"},
                         "text":"phone wake question","phoneWake":true});
    fixture.write("history.json", &json!({"messages":[message]}));
    fixture.write("messages.json", &json!({NEW:message}));
    fixture.write(
        "rooms.json",
        &json!([{"id":ROOM,"name":"Office","lastMessage":{"id":NEW}}]),
    );
    let notice =
        json!({"success":true,"data":{"event":{"roomId":ROOM,"messageId":NEW}}}).to_string();
    write!(phone,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{notice}",notice.len()).unwrap();
    let model = accept(&model, &mut child);
    let input = request(&model);
    kill(
        Pid::from_raw(i32::try_from(child.id()).unwrap()),
        Signal::SIGINT,
    )
    .unwrap();
    assert!(wait(&mut child).success());
    assert!(
        input["messages"][1]["content"]
            .as_str()
            .unwrap()
            .contains("phone wake question")
    );
    assert!(!fixture.0.join("post.json").exists());
}

fn wait_for_first_listing(fixture: &Fixture) {
    let until = Instant::now() + Duration::from_secs(4);
    while fixture.saved().get("_auto_dms").is_none() {
        assert!(
            Instant::now() < until,
            "native Hands did not complete its first room list"
        );
        thread::sleep(Duration::from_millis(5));
    }
}
