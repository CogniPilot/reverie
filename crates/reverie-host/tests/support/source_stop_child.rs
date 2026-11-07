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
fn output(path: &str) {
    io::stdout().write_all(&fs::read(path).unwrap()).unwrap();
}
fn legacy(args: &[String], cid: &str, name: &str) {
    if Path::new("legacy-query-delay").is_file() {
        std::thread::sleep(Duration::from_millis(80));
    }
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["ps", "-aq", "--no-trunc"] => {
            fs::write("metadata-entered",b"actual unrelated fixed native query").unwrap();wait("release-metadata");
        }
        ["inspect", target] if *target == cid || *target == name => {
            if Path::new("legacy-missing").exists()
                || (Path::new("stop-requested").exists() && Path::new("legacy-failed-inspect").exists())
            { std::process::exit(7); }
            output(if Path::new("kill-requested").exists() { "final.json" }
                else if Path::new("stop-requested").exists() { "after.json" } else { "before.json" });
        }
        ["stop", "--time", "2", target] if *target == cid || *target == name => {
            fs::write("stop-requested", target).unwrap();
            if std::env::var("SOURCE_EXIT_ON").unwrap() == "stop-requested" { wait("source-reaped"); }
            if Path::new("hold-stop-reply").exists() {
                fs::write("stop-reply-held", b"actual effect").unwrap();wait("release-stop-reply");
            }
            if Path::new("legacy-stop-nonzero").exists() { std::process::exit(7); }
        }
        ["kill", target] if *target == cid || *target == name => {
            fs::write("kill-requested", target).unwrap();wait("source-reaped");
        }
        ["ps", "--all", "--no-trunc", "--format", "{{.ID}} {{.Names}}"] => output("container-census"),
        ["network", "inspect", target] if *target == format!("{name}-lan") || *target == "b".repeat(64) => {
            if !Path::new("network-before.json").exists() || Path::new("network-removed").exists() { std::process::exit(7); }
            output("network-before.json");
        }
        ["network", "ls", "--no-trunc", "--format", "{{.ID}} {{.Name}}"] => output("network-census"),
        ["network", "disconnect", "--force", network, target] if *network == "b".repeat(64) && *target == cid => {
            fs::write("network-disconnected", network).unwrap();
        }
        ["network", "rm", network] if *network == "b".repeat(64) => {
            if Path::new("legacy-network-retained").exists() { std::process::exit(7); }
            fs::write("network-removed", network).unwrap();
        }
        _ => std::process::exit(94),
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
    if Path::new("legacy-stop").exists() { legacy(&args, &cid, &name); return; }
    let path = match args.as_slice() {
        [verb, quiet, no_trunc] if verb == "ps" && quiet == "--quiet" && no_trunc == "--no-trunc" && Path::new("registry-empty-census").exists() => return,
        [verb, target] if verb == "inspect" && target == &name => {
            if Path::new("hold-inspect-reply").exists() {
                fs::write("inspect-reply-held", b"owned query admitted").unwrap();
                wait("release-inspect-reply");
            }
            "before.json"
        }
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
