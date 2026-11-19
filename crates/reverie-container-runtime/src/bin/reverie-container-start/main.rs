//! Initialize the mounted office data before replacing this process with the console.
mod instance;

use nix::sys::stat::{Mode, umask};
use std::env;
use std::ffi::{OsStr, OsString};
use std::io::{self, ErrorKind};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

const DEFAULT_DATA: &str = "/instances/default";

fn setting(name: &str, default: impl AsRef<OsStr>) -> OsString {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.as_ref().to_owned())
}

fn configured_command() -> (OsString, Vec<OsString>) {
    let mut arguments = env::args_os().skip(1);
    match arguments.next() {
        Some(program) => (program, arguments.collect()),
        None => (
            "reverie".into(),
            vec![
                "web".into(),
                "--host".into(),
                "0.0.0.0".into(),
                "--port".into(),
                setting("REVERIE_PORT", "3000"),
            ],
        ),
    }
}

fn prepare() -> io::Result<(instance::Instance, OsString)> {
    umask(Mode::from_bits_truncate(0o077));
    let data = PathBuf::from(setting("REVERIE_DATA", DEFAULT_DATA));
    let runtime = instance::Instance::prepare(data)?;
    let previous_path = setting("PATH", "/usr/local/bin:/usr/bin:/bin");
    let path =
        env::join_paths(env::split_paths(&previous_path).chain([runtime.data().join("tools/bin")]))
            .map_err(io::Error::other)?;
    Ok((runtime, path))
}

fn background(instance: &instance::Instance, path: &OsStr, program: &str) {
    let executable = env::split_paths(path)
        .map(|directory| directory.join(program))
        .find(|candidate| {
            candidate.is_file()
                && nix::unistd::access(candidate, nix::unistd::AccessFlags::X_OK).is_ok()
        });
    if let Some(executable) = executable {
        let mut command = Command::new(executable);
        instance.configure(&mut command, path);
        if let Err(error) = command.stdin(Stdio::null()).spawn() {
            eprintln!("reverie-start: {program} could not start: {error}");
        }
    } else if program == "reverie-install-clis" {
        eprintln!(
            "reverie-start: provider installer unavailable; account sign-in requires provider tools"
        );
    }
}

fn launch(instance: &instance::Instance, path: &OsStr) -> io::Error {
    let (program, arguments) = configured_command();
    let web = Path::new(&program).file_name() == Some(OsStr::new("reverie"))
        && arguments.first().is_some_and(|argument| argument == "web");
    background(instance, path, "reverie-install-clis");
    if web {
        if setting("REVERIE_MODEL_RELAY_MANAGED", "0") != "1"
            && Path::new("/run/reverie-control").is_dir()
        {
            background(instance, path, "reverie-model-relay");
        }
        if setting("REVERIE_KOKORO_ENABLED", "1") == "1"
            && setting("REVERIE_KOKORO_URL", "").is_empty()
        {
            background(instance, path, "reverie-kokoro");
        }
        if setting("REVERIE_VOICE_ENABLED", "0") == "1"
            && setting("REVERIE_VOICE_TURN_URL", "").is_empty()
        {
            background(instance, path, "reverie-speech");
        }
    }
    let mut command = Command::new(program);
    instance.configure(&mut command, path);
    command.args(arguments).exec()
}

fn main() -> ExitCode {
    let (instance, path) = match prepare() {
        Ok(prepared) => prepared,
        Err(error) => {
            eprintln!("reverie-start: could not prepare office data: {error}");
            return ExitCode::FAILURE;
        }
    };
    let error = launch(&instance, &path);
    eprintln!("reverie-start: could not launch command: {error}");
    ExitCode::from(match error.kind() {
        ErrorKind::NotFound => 127,
        _ => 126,
    })
}
