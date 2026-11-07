//! Exact controlled readonly query vocabulary for actual recovery tests.
use std::{
    env, fs,
    io::{self, Write},
};
fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
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
        ["ps", "--quiet", "--no-trunc"] => "ids.out",
        ["inspect", "test-console"] => "server.out",
        ["inspect", name] if name.starts_with("test-agent-") => "inspect.out",
        _ => std::process::exit(83),
    };
    let mut trace = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("calls.txt")
        .unwrap();
    writeln!(trace, "{}", args.join("\0")).unwrap();
    drop(trace);
    if file == "server.out" && fs::exists("server.hold").unwrap() {
        fs::write("server.started", "actual fixed server query").unwrap();
        let end = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !fs::exists("server.release").unwrap() {
            if std::time::Instant::now() >= end {
                std::process::exit(84);
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }
    io::stdout().write_all(&fs::read(file).unwrap()).unwrap();
}
