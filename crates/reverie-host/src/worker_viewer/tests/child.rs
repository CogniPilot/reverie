//! Controlled Docker counterpart: no daemon, credentials or real employees.
use std::{env, fs, io::{Read, Write}, process::{Command, Stdio}, time::Duration};
fn main() {
    let root = env::var("VIEWER_FIXTURE_ROOT").unwrap();
    env::set_current_dir(root).unwrap();
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args == ["--agent"] {
        while !std::path::Path::new("agent-stop").exists() { std::thread::sleep(Duration::from_millis(2)); }
        return;
    }
    let mut trace = fs::OpenOptions::new().create(true).append(true).open("trace").unwrap();
    writeln!(trace, "{}", args.join("\0")).unwrap();
    if args.first().map(String::as_str) == Some("inspect") {
        assert_eq!(args, ["inspect", "viewer-agent-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]);
        let cid = fs::read_to_string("cid").unwrap();
        let running = fs::read_to_string("running").unwrap_or_else(|_| "true".into());
        print!("[{{\"Id\":\"{cid}\",\"Name\":\"/{}\",\"Config\":{{\"Labels\":{{\"reverie.worker\":\"viewer\",\"reverie.session\":\"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\",\"reverie.employee\":\"11111111-2222-4333-8444-555555555555\"}}}},\"State\":{{\"Running\":{running}}}}}]", args[1]);
        return;
    }
    assert_eq!(args.first().map(String::as_str), Some("exec"));
    assert!(args.windows(2).any(|args| args == ["--env", "LANG=C.UTF-8"]));
    assert!(args.windows(2).any(|args| args == ["--env", "LC_ALL=C.UTF-8"]));
    assert!(args.windows(4).any(|args| args == ["/bin/tmux", "-u", "-L", "reverie-laptop"]));
    assert_eq!(&args[args.len()-4..], ["attach-session", "-d", "-t", "office"].as_slice(), "fixed attach suffix");
    assert!(args.iter().any(|arg| arg == &"c".repeat(64)));
    print!("READY › ──\n"); std::io::stdout().flush().unwrap();
    let mut bytes = [0; 1024];
    loop {
        match std::io::stdin().read(&mut bytes) {
            Ok(0) => { fs::write("agent-stop", b"unexpected forwarded EOF").unwrap(); return; },
            Ok(count) => {
                if bytes[..count].contains(&b'S') {
                    let size = Command::new("stty").arg("size").stdin(Stdio::inherit()).output().unwrap();
                    std::io::stdout().write_all(&size.stdout).unwrap();
                } else { std::io::stdout().write_all(&bytes[..count]).unwrap(); }
                std::io::stdout().flush().unwrap();
            },
            Err(_) => return,
        }
    }
}
