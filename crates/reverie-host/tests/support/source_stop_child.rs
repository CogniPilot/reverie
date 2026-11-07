//! Owned fixture only: exact metadata commands and a controlled target process.
//! No signal, caller-selected executable, PID or production path is accepted.
use std::{
    fs,
    io::{self, Write},
    path::Path,
    time::{Duration, Instant},
};
fn wait(path: &str) {
    let end = Instant::now() + Duration::from_secs(30);
    while !Path::new(path).exists() {
        assert!(Instant::now() < end, "owned fixture release absent");
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args == ["target"] {
        fs::write("source-ready", b"ready").unwrap();
        let trigger = std::env::var("SOURCE_EXIT_ON").unwrap();
        while !Path::new("release-source").exists() && !Path::new(&trigger).exists() {
            std::thread::sleep(Duration::from_millis(1));
        }
        return;
    }
    let mut trace = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("trace")
        .unwrap();
    writeln!(trace, "{}", args.join("\0")).unwrap();
    let cid = fs::read_to_string("cid").unwrap();
    let name = fs::read_to_string("name").unwrap();
    let path = match args.as_slice() {
        [verb, target] if verb == "inspect" && target == &name => "before.json",
        [verb, time, seconds, target]
            if verb == "stop" && time == "--time" && seconds == "2" && target == &cid =>
        {
            fs::write("stop-requested", b"stop").unwrap();
            if std::env::var("SOURCE_EXIT_ON").unwrap() == "stop-requested" {
                wait("source-reaped");
            }
            if Path::new("hold-stop-reply").exists() {
                fs::write("stop-reply-held", b"owned effect before reply").unwrap();
                wait("release-stop-reply");
            }
            if std::env::var("SOURCE_STOP_OPTIONAL_ERROR").is_ok() {
                std::process::exit(7);
            }
            return;
        }
        [verb, target] if verb == "kill" && target == &cid => {
            fs::write("kill-requested", b"kill").unwrap();
            wait("source-reaped");
            return;
        }
        [verb, target] if verb == "inspect" && target == &cid => {
            if Path::new("kill-requested").exists() {
                "final.json"
            } else {
                "after.json"
            }
        }
        _ => std::process::exit(94),
    };
    io::stdout().write_all(&fs::read(path).unwrap()).unwrap();
}
