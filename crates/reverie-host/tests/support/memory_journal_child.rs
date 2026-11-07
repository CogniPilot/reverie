//! Owned compiled public-client transport fixture. It is not an API authority
//! or a production journal/model; every output/effect is synthetic test data.
use std::{io::Write,os::unix::ffi::OsStrExt};
fn main(){
    let args=std::env::args_os().skip(1).collect::<Vec<_>>();
    let program=std::env::current_exe().unwrap();let mode=program.file_name().unwrap().to_str().unwrap();
    if let Some(trace)=std::env::var_os("OWNED_JOURNAL_TRACE"){
        use std::io::Write;
        std::fs::OpenOptions::new().create(true).append(true).open(trace).unwrap().write_all(b"started\n").unwrap();
    }
    if let Some(effect)=std::env::var_os("OWNED_JOURNAL_EFFECT"){std::fs::write(effect,b"synthetic-effect-may-complete-before-reply").unwrap();}
    match mode{
        "nonzero"=>{println!(r#"{{"success":false,"error":"synthetic refusal"}}"#);std::process::exit(7);},
        "empty"=>(),
        "badutf8"=>{std::io::stdout().write_all(&[0xff]).unwrap();},
        "hold"=>std::thread::sleep(std::time::Duration::from_secs(10)),
        "dual"=>{let other=std::thread::spawn(||flood(std::io::stderr()));flood(std::io::stdout());other.join().unwrap();},
        _=>{
            if args.iter().any(|arg|arg=="recall"){println!(r#"{{"success":true,"data":{{"entries":[{{"entryId":"synthetic-id"}}]}}}}"#);return;}
            let encoded=args.iter().map(|arg|format!("\"{}\"",hex(arg.as_bytes()))).collect::<Vec<_>>().join(",");
            let env=std::env::vars_os().filter(|(key,_)|key=="RAW_PROBE").map(|(_,value)|format!("\"{}\"",hex(value.as_bytes()))).collect::<Vec<_>>().join(",");
            println!(r#"{{"success":true,"data":{{"entryId":"synthetic-id","argv":[{encoded}],"environment":[{env}]}}}}"#);
        }
    }
}
fn hex(bytes:&[u8])->String{bytes.iter().map(|byte|format!("{byte:02x}")).collect()}
fn flood(mut output:impl Write){let chunk=[b'x';65536];for _ in 0..80{output.write_all(&chunk).unwrap();}}
