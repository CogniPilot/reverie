//! Owned controlled counterpart for the fixed laptop network effect only.
//! It never invokes a real engine, daemon, company service or mount.
use std::{env,fs::{self,OpenOptions},io::Write,path::Path,time::{Instant,Duration}};
fn main() {
    let args=env::args().skip(1).collect::<Vec<_>>();
    let mode=env::var("LAPTOP_FIXTURE_MODE").unwrap();
    let mut trace=OpenOptions::new().append(true).create(true).open("trace").unwrap();
    writeln!(trace,"{}",args.join("\0")).unwrap();drop(trace);
    if args.starts_with(&["image".into(),"inspect".into()]) {print!("[{{\"Config\":{{\"Labels\":{{\"reverie.worker.nix-store\":\"0\"}}}}}}]");return;}
    if args==["ps","--quiet","--no-trunc"] {return;}
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
