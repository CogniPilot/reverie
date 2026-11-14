//! Static fixed client entry: sanitize before a dynamic loader or Node can run.
#![forbid(unsafe_code)]
use std::{ffi::OsString, os::unix::process::CommandExt, process::Command};
mod install;
const NODE: &str = "/opt/reverie-worker-client/bin/node";
const SCRIPT: &str = "/opt/reverie-worker-client/bin/reverie.mjs";
const KEYS: &[&str] = &[
    "HOME",
    "TERM",
    "REVERIE_MUX",
    "REVERIE_SESSION_ID",
    "REVERIE_API_URL",
    "REVERIE_WORKER_IDENTITY_FILE",
    "REVERIE_HOOK_GENERATION",
];
fn readonly_role(args: &[OsString]) -> bool {
    match args {
        [help] => matches!(help.to_str(), Some("--help" | "-h")),
        [group, role] => group == "worker-client" && role == "hook-settings",
        [group, role, option, digest] => {
            group == "worker-client"
                && role == "status"
                && option == "--expected-digest"
                && digest.to_str().is_some_and(|value| {
                    value.len() == 64
                        && value
                            .bytes()
                            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                })
        }
        _ => false,
    }
}
fn command(
    args: &[OsString],
    environment: impl IntoIterator<Item = (OsString, OsString)>,
) -> Result<Command, &'static str> {
    let selected = environment
        .into_iter()
        .filter(|(key, _)| key.to_str().is_some_and(|key| KEYS.contains(&key)))
        .collect::<Vec<_>>();
    if !readonly_role(args)
        && !selected
            .iter()
            .any(|(key, value)| key == "REVERIE_WORKER_IDENTITY_FILE" && !value.is_empty())
    {
        return Err("a private bound worker credential file is required");
    }
    let mut command = Command::new(NODE);
    command
        .env_clear()
        .env("PATH", "/bin:/usr/bin")
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8");
    command
        .envs(selected)
        .args(["--no-global-search-paths", "--no-addons", SCRIPT])
        .args(args);
    Ok(command)
}
fn main() -> std::process::ExitCode {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if let Some(result) = install::arguments(&args) {
        return match result.and_then(install::run) {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("worker credential install refused or unconfirmed: {error}");
                std::process::ExitCode::FAILURE
            }
        };
    }
    let error = match command(&args, std::env::vars_os()) {
        Ok(mut command) => command.exec().to_string(),
        Err(message) => message.to_owned(),
    };
    eprintln!("worker client refused: {error}");
    std::process::ExitCode::FAILURE
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }
    #[test]
    fn only_exact_readonly_roles_work_without_a_credential() {
        assert!(command(&args(&["--help"]), []).is_ok());
        assert!(command(&args(&["worker-client", "hook-settings"]), []).is_ok());
        assert!(
            command(
                &args(&[
                    "worker-client",
                    "status",
                    "--expected-digest",
                    &"a".repeat(64)
                ]),
                []
            )
            .is_ok()
        );
        for values in [
            &["agent", "ls"][..],
            &["--", "agent", "ls"],
            &["worker-client", "hook-settings", "agent"],
        ] {
            assert!(command(&args(values), []).is_err());
        }
    }
    #[test]
    fn empty_environment_blocks_autoload_and_never_uses_a_selected_program_or_path() {
        let environment = [
            ("LD_PRELOAD", "/evil.so"),
            ("LD_AUDIT", "/evil.so"),
            ("NODE_OPTIONS", "--require=/evil.cjs"),
            ("NODE_COMPILE_CACHE", "/evil"),
            ("NODE_PATH", "/evil"),
            ("PATH", "/evil"),
            ("REVERIE_PASSWORD", "forbidden"),
            ("REVERIE_WORKER_SOCKET", "/evil"),
            (
                "REVERIE_WORKER_IDENTITY_FILE",
                "/home/agent/private/identity",
            ),
            ("REVERIE_SESSION_ID", "actual-session"),
        ]
        .into_iter()
        .map(|(key, value)| (OsString::from(key), OsString::from(value)));
        let command = command(&args(&["agent", "ls"]), environment).unwrap();
        assert_eq!(command.get_program(), OsStr::new(NODE));
        let selected = command
            .get_envs()
            .filter_map(|(key, value)| value.map(|value| (key.to_owned(), value.to_owned())))
            .collect::<Vec<_>>();
        for blocked in [
            "LD_PRELOAD",
            "LD_AUDIT",
            "NODE_OPTIONS",
            "NODE_COMPILE_CACHE",
            "NODE_PATH",
            "REVERIE_PASSWORD",
            "REVERIE_WORKER_SOCKET",
        ] {
            assert!(!selected.iter().any(|(key, _)| key == blocked));
        }
        assert!(
            selected
                .iter()
                .any(|(key, value)| key == "PATH" && value == "/bin:/usr/bin")
        );
        assert_eq!(
            command.get_args().take(3).collect::<Vec<_>>(),
            [
                OsStr::new("--no-global-search-paths"),
                OsStr::new("--no-addons"),
                OsStr::new(SCRIPT)
            ]
        );
    }
}
