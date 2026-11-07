//! Owned controlled counterpart for the fixed laptop lifecycle effects.
//! It never invokes a real engine, daemon, company service or mount.
use std::{env,fs::{self,OpenOptions},io::Write,path::Path,time::{Instant,Duration}};
fn main() {
    let args=env::args().skip(1).collect::<Vec<_>>();
    let mode=env::var("LAPTOP_FIXTURE_MODE").unwrap();
    let mut trace=OpenOptions::new().append(true).create(true).open("trace").unwrap();
    writeln!(trace,"{}",args.join("\0")).unwrap();drop(trace);
    if args.starts_with(&["image".into(),"inspect".into()]) {print!("[{{\"Config\":{{\"Labels\":{{\"reverie.worker.nix-store\":\"0\"}}}}}}]");return;}
    if args==["ps","--quiet","--no-trunc"] || args==["ps","--all","--filter","label=reverie.worker","--format","{{.ID}}"] {return;}
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
        pane(&args,&mode);return;
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
