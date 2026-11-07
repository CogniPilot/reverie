//! Owned controlled counterpart for the fixed laptop lifecycle effects.
//! It never invokes a real engine, daemon, company service or mount.
use std::{env,fs::{self,OpenOptions},io::Write,path::Path,time::{Instant,Duration}};
fn main() {
    let args=env::args().skip(1).collect::<Vec<_>>();
    if args==["--viewer-descendant"] { viewer_descendant();return; }
    if args==["--viewer-early-group-control"] { viewer_early_group_control();return; }
    let mode=env::var("LAPTOP_FIXTURE_MODE").unwrap();
    let mut trace=OpenOptions::new().append(true).create(true).open("trace").unwrap();
    writeln!(trace,"{}",args.join("\0")).unwrap();drop(trace);
    if Path::new("existing-stop-control").is_file() && args.first().map(String::as_str)!=Some("exec") {
        existing_stop(&args);return;
    }
    if args.starts_with(&["image".into(),"inspect".into()]) {print!("[{{\"Config\":{{\"Labels\":{{\"reverie.worker.nix-store\":\"0\"}}}}}}]");return;}
    if args==["ps","-aq","--no-trunc"] {
        assert_eq!(mode,"created-viewer-metadata");
        fs::write("metadata-entered",b"actual same-context query").unwrap();
        let end=Instant::now()+Duration::from_secs(20);
        while !Path::new("release-metadata").exists() {assert!(Instant::now()<end);std::thread::sleep(Duration::from_millis(1));}
        return;
    }
    if args==["ps","--quiet","--no-trunc"] || args==["ps","--all","--filter","label=reverie.worker","--format","{{.ID}}"] {return;}
    if args==["ps","--all","--quiet","--no-trunc"] {
        let count=fs::read_to_string("cold-ps.count").ok().map(|v|v.parse::<usize>().unwrap()).unwrap_or(0)+1;
        fs::write("cold-ps.count",count.to_string()).unwrap();
        if fs::read_to_string("cold-fail-ps-at").ok().is_some_and(|value|value.parse::<usize>().unwrap()==count){std::process::exit(9);}
        if let Ok(raw)=fs::read("cold-ps.out"){std::io::stdout().write_all(&raw).unwrap();}return;
    }
    if args.first().map(String::as_str)==Some("create") {
        assert!(mode.starts_with("created-"));
        assert_eq!(args[1],"--name");
        assert_eq!(&args[args.len()-4..args.len()-2],&["--entrypoint","/bin/sleep"]);
        assert_eq!(args.last().unwrap(),"infinity");
        fs::write("created-laptop",args.join("\0")).unwrap();
        if mode=="created-pending" {
            fs::write("laptop-create-entered",b"actual owned client").unwrap();
            let end=Instant::now()+Duration::from_secs(30);
            while !Path::new("release-laptop-create").exists() {assert!(Instant::now()<end);std::thread::sleep(Duration::from_millis(1));}
        }
        if mode=="created-nonzero" {std::process::exit(9);}
        if mode=="created-noncanonical" {print!("successful create without a canonical CID\n");return;}
        if mode=="created-bad-utf8" {std::io::stdout().write_all(&[255]).unwrap();return;}
        print!("\x1c{}\x1f\n","c".repeat(64));return;
    }
    if args.first().map(String::as_str)==Some("start") {
        assert!(mode.starts_with("created-"));assert_eq!(args.len(),2);
        let sid=args[1].strip_prefix("fixture-agent-").unwrap();
        let directory=Path::new("state").join(sid);
        let metadata=fs::read_to_string(directory.join("runtime.json")).unwrap();
        let exit=metadata.strip_prefix("{\"exit\": \"").unwrap().strip_suffix("\"}").unwrap();
        let nonce=exit.strip_suffix(".exit").unwrap();
        let args=fs::read_to_string("created-laptop").unwrap();
        let home=args.split('\0').find_map(|arg|arg.strip_prefix("type=bind,src=").and_then(|path|path.strip_suffix(",dst=/home/agent"))).unwrap();
        assert!(Path::new(home).join(".reverie-launch").join(format!("{nonce}.json")).is_file());
        fs::write("started-laptop",sid).unwrap();
        if mode=="created-start-pending" {
            fs::write("laptop-start-entered",b"actual owned start client").unwrap();
            let end=Instant::now()+Duration::from_secs(30);
            while !Path::new("release-laptop-start").exists() {assert!(Instant::now()<end);std::thread::sleep(Duration::from_millis(1));}
        }
        if mode=="created-start-nonzero" {std::process::exit(9);}
        return;
    }
    if args.first().map(String::as_str)==Some("exec") {
        if args.get(1).map(String::as_str)==Some("-it") { viewer(&args,&mode); } else { pane(&args,&mode); } return;
    }
    if args.first().map(String::as_str)==Some("stop") {
        assert_eq!(args,["stop","--time","2",&"c".repeat(64)]);
        fs::write("stopped-laptop",b"actual fixed stop effect").unwrap();
        if mode=="created-stop-bad-utf8" {std::io::stdout().write_all(&[255]).unwrap();}
        return;
    }
    if args.first().map(String::as_str)==Some("kill") {
        assert_eq!(args,["kill",&"c".repeat(64)]);
        fs::write("killed-laptop",b"actual fixed kill effect").unwrap();return;
    }
    if args.first().map(String::as_str)==Some("inspect") {
        if mode=="created-retained" {
            assert_eq!(args,["inspect",&"c".repeat(64)]);
            let count=fs::read_to_string("retained-inspect-count").ok().map(|v|v.parse::<usize>().unwrap()).unwrap_or(0)+1;
            fs::write("retained-inspect-count",count.to_string()).unwrap();
            if count==3 && Path::new("retained-inspect-next.json").exists() {
                fs::rename("retained-inspect-next.json","retained-inspect.json").unwrap();
            }
            std::io::stdout().write_all(&fs::read("retained-inspect.json").unwrap()).unwrap();return;
        }
        if Path::new("existing-inspect.json").is_file() {
            assert_eq!(args,["inspect",&format!("fixture-agent-{}",fs::read_to_string("started-laptop").unwrap())]);
            std::io::stdout().write_all(&fs::read("existing-inspect.json").unwrap()).unwrap();return;
        }
        if mode.starts_with("created-memory") {
            assert_eq!(args,["inspect",&format!("fixture-agent-{}",fs::read_to_string("started-laptop").unwrap())]);
            let row=fs::read("memory-inspect.json").unwrap();
            std::io::stdout().write_all(&row).unwrap();return;
        }
        assert_eq!(args,["inspect",&"c".repeat(64)]);
        if mode=="created-inspect-missing" {std::process::exit(1);}
        let id=if mode=="created-inspect-mismatch" {"f".repeat(64)} else {"c".repeat(64)};
        let running=mode=="created-cleanup-kill"&&!Path::new("killed-laptop").exists();
        let pid=if running {321}else{0};
        print!("[{{\"Id\":\"{id}\",\"State\":{{\"Running\":{running},\"Pid\":{pid},\"Paused\":false,\"Restarting\":false,\"Dead\":false}}}}]");return;
    }
    assert_eq!(args.first().map(String::as_str),Some("network"));
    match args[1].as_str() {
        "inspect"=>{
            if mode=="malformed" {print!("{{");return;}
            if mode=="existing"||mode=="foreign" {
                let sid=args[2].strip_prefix("fixture-agent-").unwrap().strip_suffix("-lan").unwrap();
                let deployment=if mode=="foreign" {"foreign"} else {"fixture"};
                print!("[{{\"Labels\":{{\"reverie.worker\":\"{deployment}\",\"reverie.session\":\"{sid}\"}}}}]");return;
            }
            print!("ignored malformed optional JSON {{");std::io::stdout().flush().unwrap();
            std::process::exit(1);
        },
        "create"=>{
            assert_eq!(args[2],"--label");assert_eq!(args[3],"reverie.worker=fixture");
            assert_eq!(args[4],"--label");assert!(args[5].starts_with("reverie.session="));
            assert_eq!(args[6],"--opt");assert_eq!(args[7],"com.docker.network.bridge.enable_icc=false");
            fs::write("created-network",args[8].as_bytes()).unwrap();
            if mode=="blocked-create" {
                fs::write("create-entered",b"actual owned client").unwrap();
                let deadline=Instant::now()+Duration::from_secs(30);
                while !Path::new("release-create").exists() {assert!(Instant::now()<deadline);std::thread::sleep(Duration::from_millis(1));}
            }
            if mode=="failed-create" {std::process::exit(9);}
            print!("{}\n","d".repeat(64));
        },
        _=>panic!("unsupported fixed laptop command"),
    }
}
fn existing_stop(args: &[String]) {
    let name=format!("fixture-agent-{}",fs::read_to_string("started-laptop").unwrap());
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["inspect",target] if *target==name || *target=="c".repeat(64) => {
            if Path::new("stopped-laptop").exists() && Path::new("existing-stop-failed-inspect").exists(){std::process::exit(7);}
            let file=if Path::new("stopped-laptop").exists(){"existing-after.json"}else{"existing-inspect.json"};
            std::io::stdout().write_all(&fs::read(file).unwrap()).unwrap();
        }
        ["stop","--time","2",target] if *target=="c".repeat(64) => {fs::write("stopped-laptop",target).unwrap();}
        ["ps","--all","--no-trunc","--format","{{.ID}} {{.Names}}"] => {std::io::stdout().write_all(&fs::read("existing-stop-census").unwrap()).unwrap();}
        ["network","inspect",_] => std::process::exit(7),
        ["network","ls","--no-trunc","--format","{{.ID}} {{.Name}}"] => {},
        _ => std::process::exit(95),
    }
}
fn pane(args:&[String],mode:&str) {
    assert!(mode.starts_with("created-"));
    assert_eq!(&args[..9],&["exec","--env","LANG=C.UTF-8","--env","LC_ALL=C.UTF-8","--env","TERM=xterm-256color","--env","COLORTERM=truecolor"]);
    let sid=fs::read_to_string("started-laptop").unwrap();
    assert_eq!(args[9],format!("fixture-agent-{sid}"));
    assert_eq!(&args[10..14],&["/bin/tmux","-u","-L","reverie-laptop"]);
    let status=args.get(14).map(String::as_str)==Some("set-option");
    if status {
        assert_eq!(&args[14..],&["set-option","-g","status","off"]);
        assert!(Path::new("pane-created").is_file());
        fs::write("pane-status",b"actual status-off client").unwrap();
    } else {
        let metadata=fs::read_to_string(Path::new("state").join(&sid).join("runtime.json")).unwrap();
        let exit=metadata.strip_prefix("{\"exit\": \"").unwrap().strip_suffix("\"}").unwrap();
        let nonce=exit.strip_suffix(".exit").unwrap();
        let record=format!("/home/agent/.reverie-launch/{nonce}.json");
        let receipt=format!("/home/agent/.reverie-launch/{exit}");
        assert_eq!(&args[14..],&["-f","/dev/null","new-session","-d","-x","80","-y","24","-s","office","/bin/reverie-worker-child","--pane-exit",&receipt,&record,";","set-option","-g","remain-on-exit","on"]);
        fs::write("pane-created",args.join("\0")).unwrap();
    }
    let part=if status {"status"} else {"start"};
    if mode==format!("created-pane-{part}-pending") {
        fs::write("pane-entered",b"actual owned tmux client").unwrap();
        let end=Instant::now()+Duration::from_secs(30);
        while !Path::new("release-pane").exists() {assert!(Instant::now()<end);std::thread::sleep(Duration::from_millis(1));}
    }
    if mode==format!("created-pane-{part}-nonzero") {std::process::exit(9);}
    if mode==format!("created-pane-{part}-bad-utf8") {std::io::stdout().write_all(&[255]).unwrap();}
}

// Linux-only owned fixture. All foreign calls target this fixture process:
// fixed dispositions and read-only stdio identity, never caller PIDs/signals.
unsafe extern "C" { fn signal(sig:i32,handler:usize)->usize; fn isatty(fd:i32)->i32; }
static WINCH: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
extern "C" fn winch(_:i32) { WINCH.fetch_add(1,std::sync::atomic::Ordering::Relaxed); }
fn viewer_descendant() {
    // SAFETY: fixed SIGTERM ignore in this isolated owned fixture only.
    unsafe { signal(15,1); }
    fs::write("viewer-descendant",std::process::id().to_string()).unwrap();
    let end=Instant::now()+Duration::from_secs(20);
    while Instant::now()<end && !Path::new("release-viewer-descendant").exists() {std::thread::sleep(Duration::from_millis(1));}
}
fn viewer_early_group_control() {
    let _child=std::process::Command::new(env::current_exe().unwrap()).arg("--viewer-descendant").spawn().unwrap();
    let end=Instant::now()+Duration::from_secs(3);
    while !Path::new("viewer-descendant").exists() {assert!(Instant::now()<end);std::thread::sleep(Duration::from_millis(1));}
    std::process::exit(7);
}
fn viewer(args:&[String],mode:&str) {
    use std::io::Read;
    assert_eq!(&args[..10],&["exec","-it","--env","LANG=C.UTF-8","--env","LC_ALL=C.UTF-8","--env","TERM=xterm-256color","--env","COLORTERM=truecolor"]);
    assert_eq!(args[10],"--env");let marker=args[11].strip_prefix("REVERIE_VIEWER=").unwrap();
    assert_eq!(marker.len(),32);assert!(marker.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)));
    assert_eq!(args[12],format!("fixture-agent-{}",fs::read_to_string("started-laptop").unwrap()));
    assert_eq!(&args[13..],&["/bin/tmux","-u","-L","reverie-laptop","attach-session","-d","-t","office"]);
    // SAFETY: fixed stdio descriptor observations and handler in the owned
    // subprocess. Handler only updates a lock-free atomic, never allocates.
    assert!((0..3).all(|fd|unsafe { isatty(fd)==1 }));
    unsafe { signal(28,winch as *const () as usize); }
    let stat=fs::read_to_string("/proc/self/stat").unwrap();
    let tail=stat.rsplit_once(") ").unwrap().1.split_whitespace().collect::<Vec<_>>();
    let pid=std::process::id().to_string();assert_eq!(tail[2],pid);assert_eq!(tail[3],pid);
    fs::write("viewer-identity",format!("{pid} {} {}",tail[2],tail[3])).unwrap();
    if mode=="created-viewer-group" || mode=="created-viewer-early-group" {
        if mode=="created-viewer-group" {unsafe { signal(15,1); }}
        let _child=std::process::Command::new(env::current_exe().unwrap()).arg("--viewer-descendant").spawn().unwrap();
        let end=Instant::now()+Duration::from_secs(3);while !Path::new("viewer-descendant").exists() {assert!(Instant::now()<end);std::thread::sleep(Duration::from_millis(1));}
    }
    fs::write("viewer-ready",marker).unwrap();
    if mode=="created-viewer-early-group" {std::process::exit(7);}
    if mode=="created-viewer-exit" { std::io::stdout().write_all(b"LAST").unwrap();std::process::exit(7); }
    if mode=="created-viewer-group" {std::thread::sleep(Duration::from_secs(20));return;}
    loop {
        let mut byte=[0];if std::io::stdin().read(&mut byte).unwrap()==0 {return;}
        if byte==[b'Q'] { std::process::exit(7); }
        if byte==[b'W'] {write!(std::io::stdout(),"WINCH={};",WINCH.load(std::sync::atomic::Ordering::Relaxed)).unwrap();}
        else {std::io::stdout().write_all(&byte).unwrap();}
        std::io::stdout().flush().unwrap();
    }
}
