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
        ["ps", "-aq", "--no-trunc"] => "ids.out",
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
}
