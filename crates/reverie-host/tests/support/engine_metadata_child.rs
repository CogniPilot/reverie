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
        "gpu-info"=>gpu_info(&args),
        "storage-writer" | "image-refresh" | "command-telemetry" => {
            use std::fs::{self,OpenOptions};
            let mut trace=OpenOptions::new().create(true).append(true).open("calls.txt").unwrap();
            writeln!(trace,"{}",args.join("\0")).unwrap();drop(trace);
            if mode == "image-refresh" && fs::remove_file("hold.next").is_ok() {
                fs::write("query-started", b"actual owned child reached query").unwrap();
                let ceiling = std::time::Instant::now() + Duration::from_secs(15);
                while !std::path::Path::new("query-release").exists() {
                    assert!(std::time::Instant::now() < ceiling, "bounded owning setup releases child");
                    std::thread::sleep(Duration::from_millis(2));
                }
            }
            let name=match args.first().map(String::as_str){Some("ps")=>"ps.out",Some("inspect")=>"inspect.out",_=>std::process::exit(81)};
            io::stdout().write_all(&fs::read(name).unwrap()).unwrap();
            if let Ok(status)=fs::read_to_string(format!("{name}.status")){std::process::exit(status.parse().unwrap());}
        }
        "dual" | "dual-over" | "dual8" => {
            let each = if mode == "dual8" {
                4 * 1024 * 1024
            } else {
                2 * 1024 * 1024
            };
            let stdout = std::thread::spawn(move || {
                let data = vec![b'o'; each];
                io::stdout().write_all(&data).unwrap();
            });
            let extra = usize::from(mode == "dual-over");
            let stderr = std::thread::spawn(move || {
                let data = vec![b'e'; each + extra];
                io::stderr().write_all(&data).unwrap();
            });
            stdout.join().unwrap();
            stderr.join().unwrap();
        }
        "overflow" => {
            let data = vec![b'e'; 4 * 1024 * 1024 + 1];
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
fn gpu_info(args:&[String]){
    use std::fs;
    assert!(args.len()==3&&args[0]=="info"&&args[1]=="--format","fixed GPU information purpose only");
    let count=fs::read_to_string("info-count").map_or(0,|value|value.parse::<u32>().unwrap())+1;
    fs::write("info-count",count.to_string()).unwrap();
    let mut trace=fs::OpenOptions::new().create(true).append(true).open("calls.txt").unwrap();
    writeln!(trace,"{}",args.join("\0")).unwrap();drop(trace);
    if count==2&&fs::exists("replace-on-second-info").unwrap(){
        fs::copy("replacement-spec.json","cdi/device.json").unwrap();
    }
    io::stdout().write_all(&fs::read("info.json").unwrap()).unwrap();
}
