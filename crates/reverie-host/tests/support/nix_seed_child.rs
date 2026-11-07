//! Owned Rust child for the fixed Nix bootstrap. No engine, shell, real Nix
//! invocation, live store or company path is accessed by this fixture.
use std::{env, fs, io::{self, Read, Write}, os::unix::fs::PermissionsExt, path::PathBuf};
fn main() {
    let program = env::current_exe().unwrap();
    let mode = env::var("SEED_MODE").unwrap_or_default();
    let state = PathBuf::from(env::var_os("NIX_STATE_DIR").unwrap());
    let root = state.parent().unwrap();
    if program.file_name().unwrap() == "nix-store" {
        if mode == "stall" { std::thread::sleep(std::time::Duration::from_secs(60)); }
        let mut input = Vec::new();
        io::stdin().read_to_end(&mut input).unwrap();
        fs::write(root.join("actual-registration"), input).unwrap();
        fs::write(root.join("load-args"), env::args().skip(1).collect::<Vec<_>>().join("\0")).unwrap();
        fs::create_dir_all(state.join("db")).unwrap();
        fs::write(state.join("db/db.sqlite"), b"owned-test-database").unwrap();
        if mode == "import-failed" {
            io::stdout().write_all(&[0xff]).unwrap();
            std::process::exit(7);
        }
        return;
    }
    assert_eq!(fs::metadata(state.join("db/db.sqlite")).unwrap().permissions().mode() & 0o222, 0);
    fs::write(root.join("copy-args"), env::args().skip(1).collect::<Vec<_>>().join("\0")).unwrap();
    let stdout = std::thread::spawn(|| {
        let block = "é€𐀀".repeat(20_000);
        for _ in 0..80 { io::stdout().write_all(block.as_bytes()).unwrap(); }
    });
    let stderr = std::thread::spawn(|| {
        for _ in 0..80 { io::stderr().write_all(&[b'e'; 65_536]).unwrap(); }
    });
    stdout.join().unwrap(); stderr.join().unwrap();
    if mode == "copy-failed" { std::process::exit(9); }
}
