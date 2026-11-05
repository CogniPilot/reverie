//! Controlled Rust test child. It is compiled into task-owned temporary storage;
//! no product binary, shell, Python, engine, service, socket or mount is used.
use std::{
    env,
    io::{self, Write},
    os::unix::ffi::OsStrExt,
    time::Duration,
};
fn main() {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.first().map(String::as_str) == Some("__descendant") {
        std::thread::sleep(Duration::from_millis(250));
        return;
    }
    let executable = env::current_exe().unwrap();
    let mode = executable.file_name().unwrap().to_str().unwrap();
    match mode {
        "dual" => {
            let stdout = std::thread::spawn(|| {
                let data = vec![b'o'; 4 * 1024 * 1024];
                io::stdout().write_all(&data).unwrap();
            });
            let stderr = std::thread::spawn(|| {
                let data = vec![b'e'; 4 * 1024 * 1024];
                io::stderr().write_all(&data).unwrap();
            });
            stdout.join().unwrap();
            stderr.join().unwrap();
        }
        "overflow" => {
            let data = vec![b'e'; 8 * 1024 * 1024 + 1];
            let _ = io::stderr().write_all(&data);
        }
        "badout" => {
            io::stdout().write_all(&[255]).unwrap();
        }
        "baderr" => {
            io::stderr().write_all(&[255]).unwrap();
        }
        "failure" => {
            eprint!("synthetic-private-diagnostic");
            std::process::exit(7);
        }
        "stall" => {
            std::thread::sleep(Duration::from_secs(60));
        }
        "stream" => loop {
            if io::stdout()
                .write_all(b"bounded-continuous-output\n")
                .is_err()
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(1));
        },
        "descendant" => {
            let _ = std::process::Command::new(&executable)
                .arg("__descendant")
                .spawn()
                .unwrap();
        }
        "environment" => {
            let raw = env::var_os("RAW").unwrap();
            let hex = raw
                .as_bytes()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            print!(
                "{}|{}|{}|{}",
                env::current_dir().unwrap().display(),
                env::var("DOCKER_HOST").unwrap(),
                hex,
                env::args().next().unwrap()
            );
        }
        _ => {
            print!("{}", args.join("\0"));
        }
    }
}
