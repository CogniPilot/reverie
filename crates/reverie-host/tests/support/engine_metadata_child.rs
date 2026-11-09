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
    if args == ["__reuse_provider_target"] {
        std::fs::write("provider-ready", b"owned provider entered").unwrap();
        wait_file("release-provider");
        std::fs::write("provider-exited", b"owned provider leaving").unwrap();
        return;
    }
    if args.first().map(String::as_str) == Some("__telemetry_pipe_owner") {
        std::fs::write("pipe-owner-ready", b"actual inherited stdout owner").unwrap();
        wait_file("release-pipe-owner");
        return;
    }
    if args.first().map(String::as_str) == Some("__descendant") {
        std::thread::sleep(Duration::from_millis(250));
        return;
    }
    let executable = env::current_exe().unwrap();
    let mode = executable.file_name().unwrap().to_str().unwrap();
    match mode {
        "native-worker-service-bus" => {
            assert_eq!(args.len(), 7);
            assert_eq!(&args[..3], ["--user", "--json=short", "get-property"]);
            let property = args[6].as_str();
            let active = std::path::Path::new("manager-started").exists();
            match property {
                "MainPID" | "ControlPID" => println!("{{\"type\":\"u\",\"data\":{}}}", if active { 42 } else { 0 }),
                "Job" => println!("{}", r#"{"type":"(uo)","data":[0,"/"]}"#),
                "Slice" => println!("{}", r#"{"type":"s","data":"app.slice"}"#),
                "ControlGroup" => println!("{}",r#"{"type":"s","data":"/user.slice/user-1000.slice/user@1000.service/app.slice"}"#),
                "ExecMainPID" => println!("{{\"type\":\"u\",\"data\":{}}}",if std::path::Path::new("manager-lastpid-changed").exists() { 43 } else { 42 }),
                "InvocationID" => println!("{{\"type\":\"ay\",\"data\":{}}}",serde_json_free_invocation()),
                "ExecStart" if std::path::Path::new("manager-native-mode").exists() => println!("{}", r#"{"type":"a(sasbttttuii)","data":[["/nix/store/new-broker/bin/reverie-worker-broker",["/nix/store/new-broker/bin/reverie-worker-broker","broker","--config","${REVERIE_WORKER_CONFIG}"],false,0,0,0,0,0,0,0]]}"#),
                "ExecStart" => println!("{}", r#"{"type":"a(sasbttttuii)","data":[["/nix/store/old-broker/bin/reverie-worker-broker",["/nix/store/old-broker/bin/reverie-worker-broker","--config","${REVERIE_WORKER_CONFIG}"],false,0,0,0,0,0,0,0]]}"#),
                "ExecStartPre" => println!("{}", r#"{"type":"a(sasbttttuii)","data":[]}"#),
                "EnvironmentFiles" => {
                    let path = if std::path::Path::new("manager-native-mode").exists() { "reverie/worker-pool/service/environment" } else { ".config/reverie/worker-broker.env" };
                    println!("{{\"type\":\"a(sb)\",\"data\":[[{:?},false]]}}", std::env::current_dir().unwrap().join(path).to_str().unwrap());
                },
                _ => panic!("unexpected fixed manager property"),
            }
        },
        "native-worker-manager-rollback" => {
            if args == ["--user", "daemon-reload"] { std::fs::write("manager-reloaded", b"known fixed reload").unwrap();return; }
            if args == ["--user", "start", "reverie-worker-broker.service"] { std::fs::write("manager-started", b"known fixed start").unwrap();return; }
            assert_eq!(args, ["--user", "show", "reverie-worker-broker.service", "--property=LoadState", "--property=ActiveState", "--property=SubState", "--property=FragmentPath", "--property=DropInPaths", "--property=NeedDaemonReload"]);
            let target=std::fs::read_link(".config/systemd/user/reverie-worker-broker.service").unwrap();
            let (active,sub)=if std::path::Path::new("manager-started").exists(){("active","running")}else{("inactive","dead")};
            let fragment=if std::path::Path::new("manager-fragment-link").is_file(){env::current_dir().unwrap().join(".config/systemd/user/reverie-worker-broker.service")}else{target};
            print!("LoadState=loaded\nActiveState={active}\nSubState={sub}\nFragmentPath={}\nDropInPaths=\nNeedDaemonReload=no\n",fragment.display());
        },
        "native-worker-manager-legacy" | "native-worker-manager-slow" => {
            if args == ["--user", "stop", "reverie-worker-broker.service"] {
                let mut trace = std::fs::OpenOptions::new().append(true).create(true).open("manager-stops").unwrap();writeln!(trace,"original-stop").unwrap();
                if mode == "native-worker-manager-slow" { std::thread::sleep(Duration::from_millis(1500)); }
                std::fs::write("manager-stopped", b"known controlled stop").unwrap();return;
            }
            assert_eq!(args, ["--user", "show", "reverie-worker-broker.service", "--property=LoadState", "--property=ActiveState", "--property=SubState", "--property=FragmentPath", "--property=DropInPaths", "--property=NeedDaemonReload"]);
            let (active,sub)=if std::path::Path::new("manager-stopped").exists(){("inactive","dead")}else{("active","running")};
            print!("LoadState=loaded\nActiveState={active}\nSubState={sub}\nFragmentPath=/nix/store/old-worker/share/systemd/user/reverie-worker-broker.service\nDropInPaths=\nNeedDaemonReload=no\n");
        },
        "native-worker-manager" => {
            assert_eq!(args, ["--user", "show", "reverie-worker-broker.service", "--property=LoadState", "--property=ActiveState", "--property=SubState", "--property=FragmentPath", "--property=DropInPaths", "--property=NeedDaemonReload"]);
            print!("LoadState=loaded\nActiveState=active\nSubState=running\nFragmentPath=/nix/store/old-worker/share/systemd/user/reverie-worker-broker.service\nDropInPaths=\nNeedDaemonReload=no\n");
        },
        "telemetry-bootstrap-pending" => {
            assert_eq!(args.first().map(String::as_str), Some("ps"));
            let mut trace = std::fs::OpenOptions::new().create(true).append(true).open("calls.txt").unwrap();
            writeln!(trace, "{}", args.join("\0")).unwrap();
            drop(trace);
            let mut owned = std::process::Command::new(&executable)
                .arg("__telemetry_pipe_owner").spawn().unwrap();
            wait_file("pipe-owner-ready");
            std::fs::write("query-started", b"owned constructor and actual pipe owner ready").unwrap();
            wait_file("release-pipe-owner");
            assert!(owned.wait().unwrap().success());
        }
        "gpu-info"=>gpu_info(&args),
        "storage-writer" | "image-refresh" | "command-telemetry" | "cold-admission" => {
            use std::fs::{self,OpenOptions};
            let mut trace=OpenOptions::new().create(true).append(true).open("calls.txt").unwrap();
            writeln!(trace,"{}",args.join("\0")).unwrap();drop(trace);
            if mode == "storage-writer" && std::path::Path::new("stopped-ram-control").is_file() {
                stopped_ram(&args);
                return;
            }
            if mode == "storage-writer" && std::path::Path::new("goal-inventory-control").is_file() && goal_inventory(&args) {
                return;
            }
            if mode == "storage-writer" && std::path::Path::new("cold-launch-control").is_file() && cold_launch(&args) {
                return;
            }
            if mode == "storage-writer" && args == ["ps", "--filter", "label=reverie.worker=test", "--format", "{{.Names}}"] && std::path::Path::new("recovery-names.out").is_file() {
                io::stdout().write_all(&fs::read("recovery-names.out").unwrap()).unwrap();
                return;
            }
            if mode == "storage-writer" && args.get(17).map(String::as_str) == Some("attach-session") {
                let prefix = ["exec", "-it", "--env", "LANG=C.UTF-8", "--env", "LC_ALL=C.UTF-8", "--env", "TERM=xterm-256color", "--env", "COLORTERM=truecolor", "--env"];
                assert_eq!(&args[..11], prefix);
                let marker = args[11].strip_prefix("REVERIE_VIEWER=").unwrap();
                assert_eq!(marker.len(), 32);
                assert!(marker.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
                assert_eq!(&args[12..], ["test-agent-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "/bin/tmux", "-u", "-L", "reverie-laptop", "attach-session", "-d", "-t", "office"]);
                fs::write("viewer-ready", b"actual fixed attach child entered").unwrap();
                fs::write("viewer-pid", std::process::id().to_string()).unwrap();
                use std::io::Read;
                let mut data = [0; 1024];
                loop {
                    let n = io::stdin().read(&mut data).unwrap();
                    if n == 0 { return; }
                    io::stdout().write_all(&data[..n]).unwrap();
                    io::stdout().flush().unwrap();
                }
            }
            if mode == "storage-writer" && std::path::Path::new("reuse-finalizer-control").is_file() {
                reuse_finalizer(&args);return;
            }
            if mode == "image-refresh" && fs::remove_file("hold.next").is_ok() {
                fs::write("query-started", b"actual owned child reached query").unwrap();
                let ceiling = std::time::Instant::now() + Duration::from_secs(15);
                while !std::path::Path::new("query-release").exists() {
                    assert!(std::time::Instant::now() < ceiling, "bounded owning setup releases child");
                    std::thread::sleep(Duration::from_millis(2));
                }
            }
            let name=match args.first().map(String::as_str){Some("ps")=>"ps.out",Some("inspect")=>"inspect.out",Some("top") if args.len()==4&&args[2..]==["-eo","pid,ppid"]=>"provider-top.out",Some("exec") if args.ends_with(&["display-message", "-p", "-t", "office", "#{pane_dead}|#{pane_pid}"].map(str::to_owned)) => "provider-pane.out",Some("exec") if args.ends_with(&["display-message", "-p", "-t", "office", "#{pane_dead}"].map(str::to_owned)) => "pane.out",_=>std::process::exit(81)};
            let raw=fs::read(name).unwrap();
            if mode=="cold-admission" && name=="inspect.out" && std::path::Path::new("inspect.next").exists() {fs::rename("inspect.next","inspect.out").unwrap();}
            io::stdout().write_all(&raw).unwrap();
            if name == "pane.out" && let Ok(next) = fs::read("pane.next") {
                fs::write("pane.out", next).unwrap();
                fs::remove_file("pane.next").unwrap();
            }
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
fn serde_json_free_invocation() -> String {
    let value=if std::path::Path::new("manager-invocation-changed").exists() { "2" } else { "1" };
    format!("[{}]",vec![value;16].join(","))
}

fn stopped_ram(args: &[String]) {
    use std::{fs, path::Path};
    if args == ["ps", "--quiet", "--no-trunc"] {
        io::stdout().write_all(&fs::read("ps.out").unwrap()).unwrap();
        return;
    }
    let format = concat!(
        "{\"Id\":{{json .Id}},\"Name\":{{json .Name}},\"Image\":{{json .Image}},",
        "\"Config\":{\"Labels\":{{json .Config.Labels}}},",
        "\"State\":{\"Running\":{{json .State.Running}},\"Pid\":{{json .State.Pid}}},",
        "\"Mounts\":{{json .Mounts}},\"HostConfig\":{",
        "\"Memory\":{{json .HostConfig.Memory}},\"MemorySwap\":{{json .HostConfig.MemorySwap}},",
        "\"PidsLimit\":{{json .HostConfig.PidsLimit}},\"NanoCpus\":{{json .HostConfig.NanoCpus}}}}"
    );
    let stopped = format.replace(
        "\"Pid\":{{json .State.Pid}}}",
        concat!(
            "\"Pid\":{{json .State.Pid}},\"Status\":{{json .State.Status}},",
            "\"StartedAt\":{{json .State.StartedAt}},\"Paused\":{{json .State.Paused}},",
            "\"Restarting\":{{json .State.Restarting}},\"Dead\":{{json .State.Dead}}}"
        ),
    );
    let output = if args == ["ps", "-aq", "--no-trunc"] {
        if fs::remove_file("ram-hold.next").is_ok() {
            fs::write("ram-query-started", b"actual fixed census child entered").unwrap();
            wait_file("ram-query-release");
        }
        let before = fs::read("ram-ids.out").unwrap();
        if Path::new("ram-ids.next").is_file() {
            fs::rename("ram-ids.next", "ram-ids.out").unwrap();
        }
        before
    } else {
        assert_eq!(args.len(), 4);
        assert_eq!(&args[..2], ["inspect", "--format"]);
        assert_eq!(args[3], "c".repeat(64));
        let file = if args[2] == format {
            "ram-row.out"
        } else {
            assert_eq!(args[2], stopped);
            "ram-stopped.out"
        };
        fs::read(file).unwrap()
    };
    io::stdout().write_all(&output).unwrap();
}
fn goal_inventory(args: &[String]) -> bool {
    let name = if args == ["ps","--all","--no-trunc","--quiet"] { "goal-ids.out" }
        else if args.first().map(String::as_str) == Some("inspect") {
            let expected = std::fs::read_to_string("goal-ids.out").unwrap();
            assert_eq!(&args[1..],expected.lines().collect::<Vec<_>>());
            "goal-inventory.out"
        } else { return false; };
    if std::path::Path::new("goal-stall-read").is_file() {
        std::thread::sleep(Duration::from_secs(2));
    }
    io::stdout().write_all(&std::fs::read(name).unwrap()).unwrap();
    if let Ok(raw) = std::fs::read("goal-ignored.stderr") { io::stderr().write_all(&raw).unwrap(); }
    true
}
fn wait_file(name: &str) {
    let end = std::time::Instant::now() + Duration::from_secs(15);
    while !std::path::Path::new(name).exists() {
        assert!(std::time::Instant::now() < end, "bounded owned fixture releases {name}");
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn cold_launch(args: &[String]) -> bool {
    use std::{fs, path::Path};
    const NAME: &str = "test-agent-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    let command = args.iter().map(String::as_str).collect::<Vec<_>>();
    match command.as_slice() {
        ["image", "inspect", image] => {
            assert_eq!(*image, format!("sha256:{}", "a".repeat(64)));
            print!("[{{\"Config\":{{\"Labels\":{{\"reverie.worker.nix-store\":\"0\"}}}}}}]");
        }
        ["network", "inspect", target] => {
            assert_eq!(*target, format!("{NAME}-lan"));
            std::process::exit(7);
        }
        ["network", "ls", "--no-trunc", "--format", "{{.ID}} {{.Name}}"] => {}
        ["stop", "--time", "2", target] => {
            assert_eq!(*target, "c".repeat(64));
            if Path::new("cold-stop-refused").is_file() { std::process::exit(7); }
            if let Ok(pid) = fs::read_to_string("viewer-pid") {
                let stat = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
                assert_ne!(stat.rsplit_once(')').unwrap().1.split_whitespace().next(), Some("Z"));
                fs::write("cold-stop-before-viewer-reap", b"actual owned viewer still alive before stop").unwrap();
            }
            fs::write("cold-stopped", b"actual fixed stop child completed").unwrap();
        }
        ["kill", target] => {
            assert_eq!(*target, "c".repeat(64));
            assert!(Path::new("cold-stop-refused").is_file());
            std::process::exit(7);
        }
        ["inspect", target] if Path::new("cold-created-args").is_file()
            && (*target == NAME || *target == "c".repeat(64)) => {
            let running = !Path::new("cold-stopped").is_file();
            let pid = if running { fs::read_to_string("cold-running-pid").map_or(321, |value| value.parse::<u32>().unwrap()) } else { 0 };
            let created = fs::read_to_string("cold-created-args").unwrap();
            let policy = created.split('\0').find_map(|word| word.strip_prefix("reverie.worker-policy=")).unwrap();
            assert_eq!(policy.len(), 64);
            print!("[{{\"Id\":\"{}\",\"Name\":\"/{NAME}\",\"Config\":{{\"Labels\":{{\"reverie.worker\":\"test\",\"reverie.session\":\"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\",\"reverie.worker-policy\":\"{policy}\"}}}},\"State\":{{\"Running\":{running},\"Pid\":{pid},\"Paused\":false,\"Restarting\":false,\"Dead\":false}}}}]", "c".repeat(64));
        }
        ["network", "create", "--label", "reverie.worker=test", "--label", session, "--opt", "com.docker.network.bridge.enable_icc=false", target] => {
            assert_eq!(*session, "reverie.session=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
            assert_eq!(*target, format!("{NAME}-lan"));
            fs::write("cold-network-created", b"actual fixed network child completed").unwrap();
        }
        ["create", "--name", target, ..] => {
            assert_eq!(*target, NAME);
            assert_eq!(&command[command.len()-4..command.len()-2], ["--entrypoint", "/bin/sleep"]);
            assert_eq!(command.last(), Some(&"infinity"));
            assert!(Path::new("cold-network-created").is_file());
            fs::write("cold-created-args", args.join("\0")).unwrap();
            if Path::new("cold-create-hold").is_file() {
                fs::write("cold-create-entered", b"actual fixed create client entered").unwrap();
                wait_file("cold-create-release");
            }
            if Path::new("cold-create-nonzero").is_file() { std::process::exit(9); }
            println!("{}", "c".repeat(64));
        }
        ["start", target] => {
            assert_eq!(*target, NAME);
            assert!(Path::new("cold-created-args").is_file());
            let metadata=fs::read_to_string("state/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/runtime.json").unwrap();
            assert!(metadata.contains(".exit"));
            fs::write("cold-started", b"actual fixed start child completed").unwrap();
        }
        ["exec", ..] if command.iter().any(|arg| *arg == "new-session") => {
            assert!(command.iter().any(|arg| *arg == NAME));
            assert!(Path::new("cold-started").is_file());
            assert!(command.ends_with(&["set-option", "-g", "remain-on-exit", "on"]));
            fs::write("cold-pane-started", b"actual fixed pane child completed").unwrap();
        }
        ["exec", ..] if command.ends_with(&["set-option", "-g", "status", "off"]) => {
            assert!(command.iter().any(|arg| *arg == NAME));
            assert!(Path::new("cold-pane-started").is_file());
            fs::write("cold-pane-configured", b"actual second pane child completed").unwrap();
        }
        _ => return false,
    }
    true
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
fn reuse_finalizer(args: &[String]) {
    use std::{fs, path::Path};
    let id="a".repeat(64);
    let name="test-agent-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["inspect","test-console"] => {
            fs::write("server.started", b"actual Office query entered").unwrap();
            if Path::new("server.hold").is_file() { wait_file("server.release"); }
            // Never return a usable address or forward to an installed server.
            io::stdout().write_all(b"controlled invalid server JSON").unwrap();
        }
        ["inspect",target] if *target==name || *target==id => {
            if Path::new("finalizer-inspect-error").exists(){std::process::exit(7);}
            let leaf=if Path::new("stopped-provider").exists(){"finalizer-stopped.json"}else{"finalizer-live.json"};
            io::stdout().write_all(&fs::read(leaf).unwrap()).unwrap();
        }
        ["stop","--time","2",target] if *target==id => {
            if Path::new("finalizer-stop-error").is_file() { std::process::exit(7); }
            if let Ok(pid)=fs::read_to_string("viewer-pid") {
                let status=fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
                assert_ne!(status.rsplit_once(')').unwrap().1.split_whitespace().next(),Some("Z"));
                fs::write("stop-before-viewer-reap",b"actual live owned viewer observed").unwrap();
            }
            fs::write("release-provider",b"actual fixed stop effect").unwrap();
            wait_file("provider-exited");
            fs::write("stopped-provider",target).unwrap();
        }
        ["ps","--all","--no-trunc","--format","{{.ID}} {{.Names}}"] => {
            io::stdout().write_all(&fs::read("finalizer-census.out").unwrap()).unwrap();
        }
        ["network","inspect",_] => std::process::exit(7),
        ["network","ls","--no-trunc","--format","{{.ID}} {{.Name}}"] => {},
        _ => std::process::exit(83),
    }
}
