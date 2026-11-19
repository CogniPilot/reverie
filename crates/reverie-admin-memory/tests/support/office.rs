//! Synthetic executable implementing the installed Office membership command.
use std::{
    env, fs,
    io::{self, Read, Write},
    path::PathBuf,
    process::ExitCode,
    time::Duration,
};

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let root = PathBuf::from(args.next().unwrap());
    let args = args.collect::<Vec<_>>();
    if args
        .first()
        .is_some_and(|operation| operation == "--task-dir")
    {
        return runner(&root, &args);
    }
    if args == ["summary", "--json"] {
        println!(r#"{{"text":""}}"#);
        return ExitCode::SUCCESS;
    }
    if args.first().is_some_and(|operation| operation == "say") {
        fs::write(root.join("post.json"), serde_json::to_vec(&args).unwrap()).unwrap();
        print!("{}", fs::read_to_string(root.join("receipt.json")).unwrap());
        return ExitCode::SUCCESS;
    }
    if let [operation, room_flag, _, selector, id, json] = args.as_slice()
        && [operation.as_str(), room_flag.as_str(), json.as_str()] == ["read", "--room", "--json"]
    {
        return read(&root, selector, id);
    }
    assert_eq!(args, ["rooms", "--json"]);
    let counter = root.join("calls");
    let call = fs::read_to_string(&counter)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0_u32)
        + 1;
    fs::write(counter, call.to_string()).unwrap();
    let mode = fs::read_to_string(root.join("mode")).unwrap_or_default();
    match mode.as_str() {
        "blocked" => std::thread::sleep(Duration::from_secs(20)),
        "overflow" => io::stdout()
            .write_all(&vec![b'x'; 1_100_000])
            .unwrap_or_default(),
        "revoked" if call >= 4 => println!("[]"),
        "second-membership-revoked" if call >= 2 => println!("[]"),
        _ => print!("{}", fs::read_to_string(root.join("rooms.json")).unwrap()),
    }
    ExitCode::SUCCESS
}

fn runner(root: &std::path::Path, args: &[String]) -> ExitCode {
    assert_eq!(std::path::Path::new(&args[1]), root.join("work/fixture"));
    for name in [
        "REVERIE_HANDS_API_KEY",
        "REVERIE_API_PASSWORD",
        "REVERIE_API_URL",
    ] {
        assert!(env::var_os(name).is_none(), "{name} reached the runner");
    }
    let mut body = Vec::new();
    io::stdin().read_to_end(&mut body).unwrap();
    let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(request["name"], "read_file");
    assert_eq!(request["args"]["path"], "fixture.txt");
    fs::write(root.join("runner-request.json"), &body).unwrap();
    eprintln!(
        r#"{{"sandbox_runner":{{"rc":0,"mode":"task","reason":"done","wall_ms":10,"peak_rss_bytes":1000}}}}"#
    );
    println!(
        r#"{{"version":1,"ok":true,"output":"The fixture was read.","error":null,"truncated":false,"exit_code":0}}"#
    );
    ExitCode::SUCCESS
}

fn read(root: &std::path::Path, selector: &str, id: &str) -> ExitCode {
    match selector {
        "-n" => {
            let after_post = root.join("history-after.json");
            let alert = root.join("alert.json");
            let source = if id == "1" && alert.exists() {
                alert
            } else if root.join("post.json").exists() && after_post.exists() {
                after_post
            } else {
                root.join("history.json")
            };
            print!("{}", fs::read_to_string(source).unwrap());
        }
        "--message" => {
            if let Some(code) = match fs::read_to_string(root.join("mode")).as_deref() {
                Ok("exact-not-found") => Some("NOT_FOUND: missing message"),
                Ok("exact-failed") => Some("UNAVAILABLE: synthetic transport failure"),
                _ => None,
            } {
                println!("{}", serde_json::json!({"success": false, "error": code}));
                return ExitCode::FAILURE;
            }
            let input = fs::read(root.join("messages.json")).unwrap();
            let messages: serde_json::Value = serde_json::from_slice(&input).unwrap();
            println!("{}", serde_json::json!({"message": messages[id]}));
        }
        _ => return ExitCode::FAILURE,
    }
    ExitCode::SUCCESS
}
