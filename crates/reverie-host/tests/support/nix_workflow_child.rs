//! Controlled fixed engine counterpart. Every effect is an owned cwd file;
//! no Docker, Podman, mount, daemon, company service or host process is used.
use std::{env, fs::{self, OpenOptions}, io::Write, path::Path, time::{Duration, Instant}};
fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let mode = env::var("NIX_FIXTURE_MODE").unwrap_or_default();
    let mut trace = OpenOptions::new().append(true).create(true).open("trace").unwrap();
    writeln!(trace, "{}", args.join("\0")).unwrap(); drop(trace);
    if args.starts_with(&["image".into(), "inspect".into()]) {
        let enabled = !args[2].ends_with(&"b".repeat(64));
        print!("[{{\"Config\":{{\"Labels\":{{\"reverie.worker.nix-store\":\"{}\"}}}}}}]", if enabled { "1" } else { "0" });
        return;
    }
    let id = "c".repeat(64);
    match args[0].as_str() {
        "ps" => {
            fs::write("metadata-entered", b"owned").unwrap();
            let end = Instant::now() + Duration::from_secs(60);
            while !Path::new("release-metadata").exists() {
                assert!(Instant::now() < end);
                std::thread::sleep(Duration::from_millis(1));
            }
            fs::write("metadata-finished", b"owned").unwrap();
        },
        "inspect" if args[1].starts_with("fixture-nix-prepare-") => {
            if mode.starts_with("prior-") {
                let deployment = if mode == "prior-foreign" { "foreign" } else { "fixture" };
                let session = args[1].trim_start_matches("fixture-nix-prepare-");
                print!("[{{\"Id\":\"{}\",\"Config\":{{\"Labels\":{{\"reverie.nix-prepare\":\"{}\",\"reverie.session\":\"{}\"}}}},\"State\":{{\"Running\":{}}}}}]", "d".repeat(64), deployment, session, mode == "prior-running");
            } else { std::process::exit(1); }
        },
        "create" => {
            fs::write("created", &id).unwrap();
            if mode == "unknown-create" { print!("unknown-create-reply"); } else { print!("{id}\n"); }
        },
        "start" => { assert_eq!(args[1], id); fs::write("started", b"owned").unwrap(); },
        "inspect" => {
            assert_eq!(args[1], id);
            if mode == "lost-inspection" { std::process::exit(7); }
            fs::write("inspected", b"owned").unwrap();
            let running = mode == "running" && !Path::new("complete").exists();
            print!("[{{\"State\":{{\"Running\":{running},\"ExitCode\":{}}}}}]", usize::from(mode == "helper-failed"));
        },
        "logs" => {
            if mode == "logs-failure" { std::io::stdout().write_all(&[255]).unwrap(); }
            else { print!("owned-progress\n"); eprint!("owned-diagnostic\n"); }
        },
        "rm" => {
            if args.get(1).map(String::as_str) != Some("--force") { fs::write("old-removed", b"owned").unwrap(); return; }
            assert_eq!(args[2], id);
            fs::write("rm-entered", b"owned").unwrap();
            if mode == "rm-finalizer" {
                let end = Instant::now() + Duration::from_secs(10);
                while !Path::new("release-rm").exists() { assert!(Instant::now() < end); std::thread::sleep(Duration::from_millis(1)); }
            }
            if mode == "rm-failure" { std::process::exit(9); }
            for name in ["created", "started"] { if Path::new(name).exists() { fs::remove_file(name).unwrap(); } }
            fs::write("removed", b"owned").unwrap();
        },
        _ => panic!("unsupported controlled fixture request"),
    }
}
