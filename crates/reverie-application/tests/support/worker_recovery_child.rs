//! Exact controlled recovery queries and one owned source-stop target fixture.
use std::{
    env, fs,
    io::{self, Write},
};
fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args == ["source-stop-target"] {
        fs::write("source-target.ready", "actual owned target").unwrap();
        let end = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while !fs::exists("source-target.release").unwrap()
            && !fs::exists("source-stop.requested").unwrap()
        {
            assert!(std::time::Instant::now() < end, "owned target teardown absent");
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        return;
    }
    if source_stop(&args) { return; }
    let file = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [
            "ps",
            "--filter",
            "label=reverie.worker=test",
            "--format",
            "{{.Names}}",
        ] => "names.out",
        ["ps", "--all", "--quiet", "--no-trunc"] => "ids.out",
        ["ps", "-aq", "--no-trunc"] => "ids.out",
        ["ps", "--quiet", "--no-trunc"] => "ids.out",
        ["inspect", "test-console"] => "server.out",
        ["inspect", name] if name.starts_with("test-agent-") => "inspect.out",
        ["exec", "--env", "LANG=C.UTF-8", "--env", "LC_ALL=C.UTF-8", "--env", "TERM=xterm-256color", "--env", "COLORTERM=truecolor", name, "/bin/tmux", "-u", "-L", "reverie-laptop", "display-message", "-p", "-t", "office", "#{pane_dead}"] if *name == "test-agent-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" => "pane.out",
        ["inspect", "--format", format, ids @ ..]
            if format.starts_with("{\"Id\":{{json .Id}}")
                && !ids.is_empty()
                && ids.iter().all(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit())) => "inventory.out",
        ["inspect", id] if fs::read_to_string("source-stop.cid").is_ok_and(|cid| cid == *id) => "source-inspect.out",
        ["inspect", ..] if args.iter().skip(1).all(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit())) => "writers.out",
        _ => std::process::exit(83),
    };
    let mut trace = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("calls.txt")
        .unwrap();
    writeln!(trace, "{}", args.join("\0")).unwrap();
    drop(trace);
    let held = match file {
        "server.out" => "server",
        "names.out" => "names",
        _ => "unheld",
    };
    if fs::exists(format!("{held}.hold")).unwrap() {
        fs::write(format!("{held}.started"), "actual fixed query").unwrap();
        let end = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !fs::exists(format!("{held}.release")).unwrap() {
            if std::time::Instant::now() >= end {
                std::process::exit(84);
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }
    if file == "ids.out"
        && fs::exists("reject-after-phone").unwrap()
        && fs::exists("office/11111111-2222-3333-4444-555555555555/office.sock").unwrap()
    {
        io::stdout().write_all(b"invalid inventory ID\n").unwrap();
        return;
    }
    io::stdout().write_all(&fs::read(file).unwrap()).unwrap();
    if let Ok(status) = fs::read_to_string(format!("{file}.status")) {
        std::process::exit(status.parse().unwrap());
    }
}
fn source_stop(args: &[String]) -> bool {
    let Ok(cid) = fs::read_to_string("source-stop.cid") else { return false; };
    if args != ["stop", "--time", "2", &cid] { return false; }
    let mut trace = fs::OpenOptions::new().create(true).append(true).open("calls.txt").unwrap();
    writeln!(trace, "{}", args.join("\0")).unwrap();
    drop(trace);
    fs::write("source-stop.requested", "actual fixed stop").unwrap();
    let end = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while !fs::exists("source-target.reaped").unwrap() {
        assert!(std::time::Instant::now() < end, "actual owned source not reaped");
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    for leaf in ["inventory.out", "source-inspect.out"] {
        fs::copy(format!("stopped-{leaf}"), leaf).unwrap();
    }
    true
}
