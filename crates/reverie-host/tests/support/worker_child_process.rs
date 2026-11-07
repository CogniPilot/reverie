//! Owned test process only. No engine, service, network or user shell commands.
use std::{env,fs::{self,OpenOptions},io::Write,os::unix::ffi::OsStrExt,time::Duration};
fn hex(bytes:&[u8])->String {bytes.iter().map(|byte|format!("{byte:02x}")).collect()}
fn main() {
    let arguments=env::args_os().collect::<Vec<_>>();let mode=arguments[0].as_bytes();
    if mode==b"reverie-worker-child" {
        // Controlled pane child, not a second launch implementation: report
        // inherited stdio and return the owned fixture's selected shell status.
        let mut input=String::new();std::io::stdin().read_line(&mut input).unwrap();print!("PANE:{input}");
        std::process::exit(fs::read_to_string(&arguments[1]).unwrap().parse().unwrap());
    }
    if mode==b"stall" {loop {std::thread::sleep(Duration::from_millis(25));}}
    let output=env::var_os("OWNED_OUTPUT").unwrap();
    let mut report=format!("PID:{}\n",std::process::id());
    for arg in &arguments {report.push_str(&format!("A:{}\n",hex(arg.as_bytes())));}
    report.push_str(&format!("C:{}\n",hex(env::current_dir().unwrap().as_os_str().as_bytes())));
    for (key,value) in env::vars_os() {report.push_str(&format!("E:{}={}\n",hex(key.as_bytes()),hex(value.as_bytes())));}
    if mode==b"bash" {
        // The final owned exec fixture inherited only our two controlled relay
        // children. Reap them before exiting so the test creates no orphan
        // zombies. This is fixture teardown, not product provider cleanup proof.
        unsafe extern "C" {fn waitpid(pid:i32,status:*mut i32,options:i32)->i32;}
        let mut status=0;
        while unsafe {waitpid(-1,&mut status,0)}>0 {}
        fs::write(output,report).unwrap();
        std::process::exit(arguments[2].to_str().unwrap().parse::<i32>().unwrap_or(0));
    }
    let mut relay_output=output;relay_output.push(".relays");
    let mut file=OpenOptions::new().create(true).append(true).open(relay_output).unwrap();file.write_all(report.as_bytes()).unwrap();
    if env::var_os("OWNED_STALL").is_some() {loop {std::thread::sleep(Duration::from_millis(25));}}
}
