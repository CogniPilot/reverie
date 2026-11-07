//! Real native fixture for argv0 launch, helper and Nix subprocess controls.
use std::{env, fs, io::{self, Write}, os::unix::process::CommandExt, path::Path, process::Command};
fn main() {
    let args: Vec<_> = env::args_os().collect();
    let name = Path::new(&args[0]).file_name().unwrap();
    if name == "helper" {
        fs::OpenOptions::new().create(true).append(true)
            .open(env::var_os("AUTOENV_TEST_MARKER").unwrap()).unwrap()
            .write_all(b"called\n").unwrap();
        if let Some(value) = env::var_os("AUTOENV_TEST_HELPER_OUTPUT") {
            print!("{}", value.to_str().unwrap());
            std::process::exit(env::var("AUTOENV_TEST_HELPER_EXIT").unwrap_or_else(|_| "0".into()).parse().unwrap());
        }
        let error = Command::new(env::var_os("AUTOENV_TEST_JOBS_BINARY").unwrap()).exec();
        panic!("helper could not execute real jobs binary: {error}");
    }
    if name == "nix" {
        let encoded = args.iter().skip(1).map(|v| v.to_str().unwrap()).collect::<Vec<_>>().join("\0");
        fs::write(env::var_os("AUTOENV_TEST_NIX_ARGV").unwrap(), encoded).unwrap();
        io::stdout().write_all(&fs::read(env::var_os("AUTOENV_TEST_NIX_JSON").unwrap()).unwrap()).unwrap();
        return;
    }
    let mut output = io::stdout().lock();
    for key in ["HOME", "PATH", "CARGO_BUILD_JOBS", "REVERIE_AUTOENV_ACTIVE", "AUTOENV_PROBE", "OTHER"] {
        let value = env::var(key).unwrap_or_else(|_| "<unset>".into());
        output.write_all(format!("{key}={value}\0").as_bytes()).unwrap();
    }
    output.write_all(format!("PID={}\0", std::process::id()).as_bytes()).unwrap();
    for arg in args.iter().skip(1) {
        output.write_all(format!("ARG={}\0", arg.to_str().unwrap()).as_bytes()).unwrap();
    }
}
