//! Owned child executable for command-runner tests; never invokes Cargo.
use std::fs::OpenOptions;
use std::io::Write;
use std::process::{Command, ExitCode};

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let mut trace = OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::var_os("XTASK_FIXTURE_TRACE").expect("owned trace path"))
        .expect("owned trace");
    writeln!(trace, "{}", arguments.join(" ")).expect("write owned trace");
    if let Some(path) = std::env::var_os("XTASK_FIXTURE_CWD_TRACE") {
        let mut cwd_trace = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .expect("owned working-directory trace");
        writeln!(cwd_trace, "{}", std::env::current_dir().unwrap().display())
            .expect("write owned working-directory trace");
    }
    if arguments.first() != std::env::var("XTASK_FIXTURE_FAIL").ok().as_ref() {
        return ExitCode::SUCCESS;
    }
    if std::env::var_os("XTASK_FIXTURE_SIGNAL").is_some() {
        #[cfg(unix)]
        {
            // Signal this exact owned child, never a process selected by name.
            Command::new("kill")
                .args(["-TERM", &std::process::id().to_string()])
                .status()
                .expect("signal this owned fixture child");
        }
    }
    ExitCode::from(17)
}
