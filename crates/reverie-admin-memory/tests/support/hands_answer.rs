use super::accept;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    os::{
        fd::OwnedFd,
        unix::{net::UnixStream, process::CommandExt},
    },
    process::{Command, Stdio},
    thread,
    time::Duration,
};

fn listener() -> TcpListener {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    listener
}

fn send_response(socket: &mut TcpStream, body: Value) {
    let body = body.to_string();
    write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
}

fn read_model(socket: &TcpStream) -> Value {
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut input = BufReader::new(socket);
    let mut length = None;
    loop {
        let mut header = String::new();
        assert_ne!(input.read_line(&mut header).unwrap(), 0);
        if header == "\r\n" {
            break;
        }
        if let Some((key, value)) = header.split_once(':')
            && key.eq_ignore_ascii_case("content-length")
        {
            length = Some(value.trim().parse::<usize>().unwrap());
        }
    }
    let mut payload = vec![0; length.unwrap()];
    input.read_exact(&mut payload).unwrap();
    serde_json::from_slice(&payload).unwrap()
}

fn model(listener: &TcpListener) -> Vec<Value> {
    let replies = [
        json!({"tool_calls":[{"id":"fixture","function":{
            "name":"web_search","arguments":"{\"query\":\"blue kite\"}"
        }}]}),
        json!({"content":"<think>unfinished"}),
        json!({"content":"A blue kite."}),
    ];
    replies
        .into_iter()
        .map(|message| {
            let mut socket = accept(listener);
            let request = read_model(&socket);
            send_response(
                &mut socket,
                json!({"choices":[{"message":message,"finish_reason":"stop"}]}),
            );
            request
        })
        .collect()
}

fn search(listener: &TcpListener) {
    let mut socket = accept(listener);
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut line = String::new();
    BufReader::new(&socket).read_line(&mut line).unwrap();
    assert_eq!(
        line.replace("%20", "+"),
        "GET /search?q=blue+kite&format=json HTTP/1.1\r\n"
    );
    send_response(
        &mut socket,
        json!({"results":[{"title":"Kite","url":"https://example.com","content":"The kite is blue."}]}),
    );
}

fn request(model: &TcpListener, search: &TcpListener) -> Value {
    json!({
        "prompt": {
            "settings": {"system_preamble":"Answer plainly.","timezone":"UTC","identity_cap_chars":500,
                      "memory_cap_chars":500,"message_cap_chars":500,"prompt_cap_chars":60000,"recall_cap_chars":3000},
            "scope":{"name":"Fixture","direct":false},"room":null,"history":[],
            "message":{"id":"waking","at":100,"text":"What color is the kite?","from":{"kind":"user","name":"Fixture"}},
            "notes":[],"now":0,"reserve":0,"recalled":"",
        },
        "web":{"search":true,"fetch":false,"max_calls":1,"result_chars":500},
        "prompt_cap":60000,"summary":false,"managed":false,
        "runtime":{
            "cli":[], "cli_timeout_s":2, "provided_summary":false,
            "model":{"api_base":format!("http://{}/v1",model.local_addr().unwrap()),"timeout_s":4,
                     "max_response_bytes":262144,"payload":{"model":"fixture","max_tokens":100,"stream":false}},
            "room":null,"message_id":"waking","external_search":false,"external_fetch":false,
            "web_settings":{"search_url":format!("http://{}",search.local_addr().unwrap()),
                            "search_timeout_s":4,"search_results":1,"search_max_bytes":4096}
        }
    })
}

#[test]
fn native_answer_constructs_the_prompt_searches_once_and_retries_without_tools() {
    let model_port = listener();
    let search_port = listener();
    let (client, server) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(6)))
        .unwrap();
    let mut worker = Command::new(env!("CARGO_BIN_EXE_reverie-admin-memory"))
        .arg(format!("--hands-answer-worker={}", std::process::id()))
        .env("NO_PROXY", "127.0.0.1")
        .env("no_proxy", "127.0.0.1")
        .process_group(0)
        .stdin(Stdio::from(OwnedFd::from(server)))
        .spawn()
        .unwrap();
    let mut channel = BufReader::new(client);
    writeln!(channel.get_mut(), "{}", request(&model_port, &search_port)).unwrap();
    let calls = thread::scope(|scope| {
        let model = scope.spawn(|| model(&model_port));
        let web = scope.spawn(|| search(&search_port));
        let result = answer(&mut channel);
        assert_eq!(result["answer"], "[web] A blue kite.");
        assert_eq!(result["searches"], 1);
        web.join().unwrap();
        model.join().unwrap()
    });
    assert!(worker.wait().unwrap().success());
    assert_eq!(calls[0]["tools"][0]["function"]["name"], "web_search");
    assert!(
        calls[0]["messages"][1]["content"]
            .as_str()
            .unwrap()
            .contains("What color is the kite?")
    );
    assert!(calls[1]["tools"].is_null() && calls[2]["tools"].is_null());
    assert!(
        calls[1]["messages"]
            .to_string()
            .contains("The kite is blue.")
    );
    assert!(
        calls[1]["messages"]
            .to_string()
            .contains("You have used your web searches")
    );
    assert!(
        !calls[2]["messages"]
            .to_string()
            .contains("You have used your web searches")
    );
    assert!(
        calls[2]["messages"]
            .to_string()
            .contains("Your last reply was not a usable answer")
    );
}

fn answer(channel: &mut BufReader<UnixStream>) -> Value {
    for line in channel.lines() {
        let event: Value = serde_json::from_str(&line.unwrap()).unwrap();
        assert!(event["error"].is_null(), "{event}");
        assert!(
            event["effect"].is_null(),
            "unexpected compatibility callback {event}"
        );
        if event["answer"].is_string() {
            return event;
        }
    }
    panic!("answer worker exited before giving a result")
}
