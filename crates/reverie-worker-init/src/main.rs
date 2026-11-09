//! Fixed, single-threaded PID1 idle/reaper; never launches or execs a command.
#![forbid(unsafe_code)]

#[cfg(target_os = "linux")]
mod linux;

fn main() -> std::process::ExitCode {
    #[cfg(target_os = "linux")]
    let result = linux::run();
    #[cfg(not(target_os = "linux"))]
    let result = Err(std::io::Error::other("worker init requires Linux"));
    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("worker init refused: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}
