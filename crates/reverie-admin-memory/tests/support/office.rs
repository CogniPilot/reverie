//! Synthetic executable implementing the installed Office membership command.
use std::{
    env, fs,
    io::{self, Write},
    path::PathBuf,
    process::ExitCode,
    time::Duration,
};

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let root = PathBuf::from(args.next().unwrap());
    let args = args.collect::<Vec<_>>();
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

fn read(root: &std::path::Path, selector: &str, id: &str) -> ExitCode {
    match selector {
        "-n" => print!("{}", fs::read_to_string(root.join("history.json")).unwrap()),
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
