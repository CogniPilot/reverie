//! The service supplies these installed paths; public protocol frames cannot
//! choose a command, environment overlay or executable path.
use clap::Parser;
use std::{ffi::OsString, path::PathBuf};

#[derive(Parser)]
#[command(
    version,
    about = "Own Reverie's network listeners and supervise its TypeScript service",
    long_about = "Own Reverie's network listeners and supervise one installed TypeScript service.\n\nThe child receives the private framing channel on fd 3. Its original arguments pass unchanged after --. The front does not authenticate HTTP, replay requests or restart the child. The outer service manager owns restart and deployment.\n\nThis binary currently requires Unix. TLS and packaged service selection are separate migration gates.",
    after_help = "Service invocation:\n  reverie-front --node /installed/bin/node --entrypoint /installed/reverie/cli.js -- web --port 3000\n\nExit status follows the child (128 + signal when signalled); 70 reports a front failure. Diagnostics go to stderr. This is an installed service entrypoint, not an owner configuration or deployment command."
)]
struct Arguments {
    /// Node executable selected by the installing service
    #[arg(long, value_name = "PATH")]
    node: PathBuf,
    /// Installed JavaScript entrypoint for the TypeScript service
    #[arg(long, value_name = "PATH")]
    entrypoint: PathBuf,
    /// Original child arguments, preserved as operating-system strings
    #[arg(last = true, allow_hyphen_values = true, value_name = "TS_ARGUMENT")]
    arguments: Vec<OsString>,
}
#[cfg(unix)]
fn main() {
    let arguments = Arguments::parse();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = reverie_diagnostics::stderr(format!("reverie-front: {error}\n").as_bytes());
            std::process::exit(70);
        }
    };
    let result = runtime.block_on(reverie_front::supervisor::run(
        reverie_front::process::InstalledChild {
            node: arguments.node,
            entrypoint: arguments.entrypoint,
            arguments: arguments.arguments,
        },
    ));
    let code = match result {
        Ok(code) => code,
        Err(error) => {
            let _ = reverie_diagnostics::stderr(format!("reverie-front: {error}\n").as_bytes());
            70
        }
    };
    finish_runtime(runtime, code);
}
#[cfg(unix)]
fn finish_runtime(runtime: tokio::runtime::Runtime, code: i32) -> ! {
    // Aborting an async hostname bind does not cancel libc getaddrinfo in a
    // Tokio blocking worker. Do not wait for that worker in Runtime::drop:
    // the service process is exiting, which ends its threads. This makes no
    // claim that the resolver completed or that an external lookup was undone.
    runtime.shutdown_background();
    std::process::exit(code);
}
#[cfg(not(unix))]
fn main() {
    let _ = Arguments::parse();
    let _ = reverie_diagnostics::stderr(
        b"reverie-front: this build requires the Unix channel/process adapter\n",
    );
    std::process::exit(78);
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    #[test]
    fn process_exit_does_not_wait_for_a_blocked_resolver_worker() {
        if std::env::var_os("REVERIE_TEST_BLOCKED_RESOLVER_WORKER").is_some() {
            blocked_worker_child();
        }
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::process_exit_does_not_wait_for_a_blocked_resolver_worker",
            ])
            .env("REVERIE_TEST_BLOCKED_RESOLVER_WORKER", "child")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("runtime shutdown waited for blocked resolver worker");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn blocked_worker_child() -> ! {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (started, wait) = std::sync::mpsc::sync_channel(0);
        runtime.spawn_blocking(move || {
            started.send(()).unwrap();
            loop {
                std::thread::park();
            }
        });
        wait.recv().unwrap();
        finish_runtime(runtime, 0);
    }
}
