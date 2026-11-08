//! The `git` that the swap tests in mint.rs put first on PATH, built with rustc at test time.
//! Just before the first call naming `SWAP_AT`, it renames `SWAP_PATH` to `<SWAP_PATH>.held` and
//! puts a symlink to `SWAP_TO` in its place. Every call then runs the real git (`REAL_GIT`) with
//! the same arguments.
use std::{
    env,
    ffi::OsString,
    fs,
    os::unix::{fs::symlink, process::CommandExt},
    process::Command,
};

fn var(name: &str) -> OsString {
    env::var_os(name).unwrap_or_else(|| panic!("{name} is set"))
}

fn main() {
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    let swap = std::path::PathBuf::from(var("SWAP_PATH"));
    if args.contains(&var("SWAP_AT")) && !swap.is_symlink() {
        let mut held = swap.clone().into_os_string();
        held.push(".held");
        fs::rename(&swap, &held).expect("move the swapped path aside");
        symlink(var("SWAP_TO"), &swap).expect("put the symlink in its place");
    }
    let err = Command::new(var("REAL_GIT")).args(&args).exec();
    panic!("running the real git: {err}");
}
