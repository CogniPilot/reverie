use super::{EngineError, EngineFault, Result};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::CommandExt;
use std::{
    collections::BTreeMap,
    env,
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

/// Installing-service configuration, never request data. Resolve the configured
/// Docker/Podman program once and freeze cwd/environment, including endpoint,
/// context, auth and runtime settings. No shell or per-query argv prefix exists.
pub struct EngineBootstrap {
    program: PathBuf,
    argv0: OsString,
    environment: BTreeMap<OsString, OsString>,
    directory: PathBuf,
    #[cfg(test)]
    pub(super) hooks: super::tests::Hooks,
}
impl EngineBootstrap {
    pub fn capture(program: &OsStr) -> Result<Self> {
        Self::from_service(
            program,
            env::vars_os().collect(),
            env::current_dir().map_err(|_| invalid())?,
        )
    }
    pub fn from_service(
        program: &OsStr,
        environment: BTreeMap<OsString, OsString>,
        directory: PathBuf,
    ) -> Result<Self> {
        if program.is_empty()
            || program.as_bytes().contains(&0)
            || !directory.is_absolute()
            || directory.as_os_str().as_bytes().contains(&0)
            || environment.iter().any(|(key, value)| {
                key.is_empty()
                    || key.as_bytes().contains(&b'=')
                    || key.as_bytes().contains(&0)
                    || value.as_bytes().contains(&0)
            })
        {
            return Err(invalid());
        }
        let argv0 = program.to_owned();
        let program = resolve(program, &environment, &directory).ok_or_else(invalid)?;
        Ok(Self {
            program,
            argv0,
            environment,
            directory,
            #[cfg(test)]
            hooks: super::tests::Hooks::default(),
        })
    }
    pub(super) fn command(&self, arguments: &[OsString]) -> Command {
        let mut command = Command::new(&self.program);
        command.arg0(&self.argv0);
        command
            .args(arguments)
            .env_clear()
            .envs(&self.environment)
            .current_dir(&self.directory)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }
}
fn invalid() -> EngineError {
    EngineError::new(EngineFault::Bootstrap)
}
fn executable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|metadata| metadata.is_file()) && super::native::executable(path)
}
fn resolve(
    program: &OsStr,
    environment: &BTreeMap<OsString, OsString>,
    directory: &Path,
) -> Option<PathBuf> {
    let program = Path::new(program);
    if program.as_os_str().as_bytes().contains(&b'/') {
        let path = if program.is_absolute() {
            program.to_owned()
        } else {
            directory.join(program)
        };
        return executable(&path).then_some(path);
    }
    let search = environment
        .get(OsStr::new("PATH"))
        .map_or(OsStr::new("/bin:/usr/bin"), OsString::as_os_str);
    env::split_paths(search)
        .map(|entry| {
            if entry.is_absolute() {
                entry
            } else {
                directory.join(entry)
            }
        })
        .map(|entry| entry.join(program))
        .find(|path| executable(path))
}
