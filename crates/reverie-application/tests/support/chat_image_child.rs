//! Fixed owned M fixture engine. Never an installed engine/tool selector.
use std::{
    env, fs,
    io::{self, Write},
    time::{Duration, Instant},
};
fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let mut trace = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("calls.txt")
        .unwrap();
    writeln!(trace, "{}", args.join("\0")).unwrap();
    drop(trace);
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
        ["ps", "-aq", "--no-trunc"]
        | ["ps", "--all", "--quiet", "--no-trunc"]
        | ["ps", "--quiet", "--no-trunc"] => "ids.out",
        ["inspect", "test-console"] => "server.out",
        ["inspect", "test-agent-11111111-1111-4111-8111-111111111111"] => "inspect.out",
        _ => std::process::exit(83),
    };
    if file == "inspect.out" && fs::exists("inspect.hold").unwrap() {
        fs::write("inspect.started", b"actual captured native query").unwrap();
        let end = Instant::now() + Duration::from_secs(15);
        while !fs::exists("inspect.release").unwrap() {
            assert!(Instant::now() < end, "own query release absent");
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    io::stdout().write_all(&fs::read(file).unwrap()).unwrap();
}
