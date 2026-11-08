//! `reverie-local-model`: run GGUF models on a host NVIDIA GPU or CPU through Nix.
use reverie_local_model::{Capture, Error, Host, Runner, Usage, args::USAGE, main_with};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

/// Runs the real programs found on `PATH`.
struct System;

impl Runner for System {
    fn run(
        &mut self,
        argv: &[String],
        capture: Capture,
        env: &[(String, String)],
    ) -> Result<String, Error> {
        let (program, rest) = argv
            .split_first()
            .ok_or_else(|| Error("empty command".into()))?;
        let mut command = Command::new(program);
        command
            .args(rest)
            .envs(env.iter().map(|(key, value)| (key, value)))
            .stdin(Stdio::inherit());
        let shown = |captured: bool| {
            if captured {
                Stdio::piped()
            } else {
                Stdio::inherit()
            }
        };
        command
            .stdout(shown(capture != Capture::None))
            .stderr(shown(capture == Capture::All));
        let output = command
            .output()
            .map_err(|error| Error(format!("{program}: {error}")))?;
        if !output.status.success() {
            return Err(Error(format!(
                "Command {argv:?} returned {}",
                output.status
            )));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    fn exec(&mut self, program: &Path, args: &[String], env: &[(String, String)]) -> Error {
        nix::sys::stat::umask(nix::sys::stat::Mode::from_bits_truncate(0o077));
        let error = Command::new(program)
            .arg0("llama-server")
            .args(args)
            .envs(env.iter().map(|(key, value)| (key, value)))
            .exec();
        Error(format!("{}: {error}", program.display()))
    }
}

fn main() -> ExitCode {
    let host = Host {
        home: std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default(),
        env: std::env::vars().collect(),
        driver: PathBuf::from("/run/opengl-driver/lib"),
    };
    let argv: Vec<_> = std::env::args_os().skip(1).collect();
    match main_with(&mut System, &host, &argv) {
        Ok(()) => ExitCode::SUCCESS,
        Err(Usage::Help(text)) => {
            println!("{text}");
            ExitCode::SUCCESS
        }
        Err(Usage::Invalid(message)) => {
            eprintln!("{USAGE}\nreverie-local-model: error: {message}");
            ExitCode::from(2)
        }
        Err(Usage::Failed(error)) => {
            eprintln!("reverie-local-model: {error}");
            ExitCode::FAILURE
        }
    }
}
