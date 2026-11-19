use super::{Fixture, ROOM, SESSION, SOURCE, accept, configure, listener, request, wait};
use nix::{
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    net::{TcpListener, TcpStream},
    os::unix::process::CommandExt,
    process::{Child, Stdio},
    thread,
    time::{Duration, Instant},
};

const TASK: &str = "fixture";

struct House {
    child: Child,
    fixture: Fixture,
    model: TcpListener,
}

impl House {
    fn run(text: &str, acknowledged: bool) -> Self {
        let fixture = Fixture::new();
        let model = listener();
        let mut command = configure(&fixture, &model);
        setup(&fixture, text, acknowledged);
        let child = command
            .env("REVERIE_HANDS_API_KEY", "synthetic-key")
            .env("REVERIE_API_PASSWORD", "synthetic-secret")
            .env("REVERIE_API_URL", "http://127.0.0.1:1")
            .arg("--no-tui")
            .process_group(0)
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        Self {
            child,
            fixture,
            model,
        }
    }

    fn accept(&mut self) -> TcpStream {
        accept(&self.model, &mut self.child)
    }

    fn receipt(&self, status: &str) -> Value {
        let key = format!("{ROOM}:{SOURCE}");
        let until = Instant::now() + Duration::from_secs(6);
        loop {
            let mut state = self.fixture.saved();
            if state["_coding"][&key]["status"] == status {
                return state["_coding"][&key].take();
            }
            assert!(
                Instant::now() < until,
                "unexpected state while waiting for {status}: {state}"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn post(&self) -> String {
        let data = fs::read(self.fixture.0.join("post.json")).unwrap();
        let args: Vec<String> = serde_json::from_slice(&data).unwrap();
        args.last().unwrap().clone()
    }

    fn finish(mut self) {
        kill(Pid::from_raw(self.child.id() as i32), Signal::SIGINT).unwrap();
        assert!(wait(&mut self.child).success());
    }
}

impl Drop for House {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = kill(Pid::from_raw(self.child.id() as i32), Signal::SIGTERM);
            let _ = wait(&mut self.child);
        }
    }
}

fn setup(fixture: &Fixture, text: &str, acknowledged: bool) {
    let parsed = fs::read(fixture.0.join("agent.json")).unwrap();
    let mut config: Value = serde_json::from_slice(&parsed).unwrap();
    config["prompt_cap_chars"] = json!(120_000);
    config["admin_task"] = json!(TASK);
    config["coding"] = json!({
        "root":fixture.0.join("work"),
        "runner_argv":[env!("CARGO_BIN_EXE_reverie-room-fixture"),fixture.0],
        "tool_schema_file":fixture.0.join("tools.json"),
        "failure_telemetry":true,
        "tasks":{TASK:{"rooms":[ROOM],"delegate_sessions":[]}},
    });
    fixture.write("agent.json", &config);
    fixture.write("tools.json", &json!({
        "version":1,"args_cap":24000,"result_cap":24000,
        "tools":[{"type":"function","function":{
            "name":"read_file","description":"read workspace text",
            "parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]},
        }}],
    }));
    let message = source(text);
    fixture.write(
        "history.json",
        &json!({"messages":[message],"timeZone":"UTC"}),
    );
    fixture.write("messages.json", &json!({SOURCE:message}));
    fixture.write(
        "alert.json",
        &json!({"members":[{"sessionId":SESSION,"name":"Fixture","alertMode":null}]}),
    );
    if !acknowledged {
        fixture.write("receipt.json", &json!({}));
    }
}

fn source(text: &str) -> Value {
    let mut message = super::super::source(true);
    message["text"] = json!(text);
    message["from"] =
        json!({"kind":"user","name":"Owner","mark":"owner_typed","authenticatedOwner":true});
    message
}

fn response(socket: &mut TcpStream, message: &Value, reason: &str) {
    let content = json!({"choices":[{"message":message,"finish_reason":reason}]}).to_string();
    write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{content}", content.len()).unwrap();
}

fn tool(socket: &mut TcpStream, name: &str, arguments: Value) {
    response(
        socket,
        &json!({"content":null,"tool_calls":[{"id":"call_1","type":"function",
        "function":{"name":name,"arguments":arguments.to_string()}}]}),
        "tool_calls",
    );
}

#[test]
fn explicit_coding_keeps_the_claim_and_runs_the_scoped_worker() {
    let mut house = House::run("/code fixture read the fixture", true);
    let mut model = house.accept();
    let input = request(&model);
    assert_eq!(input["tools"][0]["function"]["name"], "read_file");
    assert!(house.post().contains("Task fixture queued"));
    assert_eq!(house.fixture.saved()[ROOM]["seen"], json!([SOURCE]));
    assert_eq!(house.receipt("started")["epoch"], 8);
    tool(&mut model, "read_file", json!({"path":"fixture.txt"}));
    let mut next = house.accept();
    assert!(
        request(&next)["messages"]
            .to_string()
            .contains("The fixture was read.")
    );
    assert!(house.fixture.0.join("runner-request.json").exists());
    response(&mut next, &json!({"content":"Read the fixture."}), "stop");
    let receipt = house.receipt("completed");
    assert_eq!(receipt["tool_history"][0]["path"], "fixture.txt");
    assert_eq!(receipt["runner_reports"], 1);
    assert_eq!(receipt["model_requests_started"], 2);
    let persisted = fs::read_to_string(house.fixture.0.join("state.json")).unwrap();
    assert!(
        persisted.find(r#""prior":"#).unwrap()
            < persisted.find(&format!(r#""{ROOM}:{SOURCE}":"#)).unwrap()
    );
    house.finish();
}

#[test]
fn coding_requires_a_confirmed_office_post_before_it_contacts_the_model() {
    let house = House::run("/code fixture read the fixture", false);
    assert_eq!(house.receipt("stopped")["reason"], "start_post_unconfirmed");
    assert!(house.post().contains("Task fixture queued"));
    assert_eq!(
        house.model.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert!(!house.fixture.0.join("runner-request.json").exists());
    house.finish();
}

#[test]
fn native_coding_checks_current_owner_again_before_a_tool_runs() {
    let text = "/code fixture read the fixture";
    let mut house = House::run(text, true);
    let mut model = house.accept();
    let _ = request(&model);
    let mut revoked = source(text);
    revoked["from"]["authenticatedOwner"] = json!(false);
    house
        .fixture
        .write("messages.json", &json!({SOURCE:revoked}));
    tool(&mut model, "read_file", json!({"path":"fixture.txt"}));
    assert_eq!(house.receipt("stopped")["reason"], "revoked");
    assert!(house.post().contains("Task fixture queued"));
    assert!(!house.fixture.0.join("runner-request.json").exists());
    house.finish();
}

#[test]
fn addressed_workspace_call_keeps_the_original_office_source() {
    let mut house = House::run("Please read the fixture.", true);
    let mut chat = house.accept();
    assert!(
        request(&chat)["tools"]
            .to_string()
            .contains("run_workspace_task")
    );
    tool(
        &mut chat,
        "run_workspace_task",
        json!({"brief":"Read the file."}),
    );
    let mut coding = house.accept();
    let prompt = request(&coding)["messages"].to_string();
    assert!(prompt.contains("Please read the fixture."));
    assert!(prompt.contains("Read the file."));
    assert!(house.post().contains("Task fixture queued"));
    response(
        &mut coding,
        &json!({"content":"Finished without asking for another tool."}),
        "stop",
    );
    assert_eq!(house.receipt("completed")["reason"], "model_finished");
    house.finish();
}

const FOLLOWUP: &str = "30000000-0000-4000-8000-000000000009";

fn newer(fixture: &Fixture, original: &str, text: &str) {
    let original = source(original);
    let mut next = source(text);
    next["id"] = json!(FOLLOWUP);
    next["at"] = json!(11);
    fixture.write("messages.json", &json!({SOURCE:original,FOLLOWUP:next}));
    fixture.write(
        "history.json",
        &json!({"messages":[original,next],"timeZone":"UTC"}),
    );
    fixture.write("rooms.json", &json!([
        {"id":ROOM,"name":"Office","visibility":"private","members":[SESSION],"lastMessage":{"id":FOLLOWUP}},
    ]));
}

#[test]
fn ordinary_chat_pauses_the_live_coding_model_and_resumes_after_reply() {
    let text = "/code fixture read the fixture";
    let mut house = House::run(text, true);
    let coding = house.accept();
    assert_eq!(
        request(&coding)["tools"][0]["function"]["name"],
        "read_file"
    );
    newer(&house.fixture, text, "A separate chat question.");
    let mut ordinary = house.accept();
    let conversation = request(&ordinary);
    assert!(
        conversation["messages"][1]
            .to_string()
            .contains("A separate chat question.")
    );
    response(
        &mut ordinary,
        &json!({"content":"An ordinary reply."}),
        "stop",
    );
    let mut resumed = house.accept();
    assert_eq!(
        request(&resumed)["tools"][0]["function"]["name"],
        "read_file"
    );
    response(
        &mut resumed,
        &json!({"content":"Finished after chat."}),
        "stop",
    );
    let receipt = house.receipt("completed");
    assert_eq!(receipt["preemptions"], 1);
    assert_eq!(receipt["model_requests_started"], 2);
    house.finish();
}

#[test]
fn the_newer_owner_cancel_stops_the_original_coding_task() {
    let text = "/code fixture read the fixture";
    let mut house = House::run(text, true);
    let coding = house.accept();
    let _ = request(&coding);
    newer(&house.fixture, text, "/code-cancel fixture");
    let receipt = house.receipt("stopped");
    assert_eq!(receipt["reason"], "cancelled");
    assert_eq!(receipt["epoch"], 8);
    assert!(!house.fixture.0.join("runner-request.json").exists());
    house.finish();
}
