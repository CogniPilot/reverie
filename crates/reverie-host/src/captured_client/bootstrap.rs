use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    os::unix::{ffi::OsStrExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
/// Fixed installing-service command snapshot. No request can construct one or
/// choose a program/prefix via the public closed engine/journal wrappers.
pub(crate) struct InstalledCommand {
    program: PathBuf,
    argv0: OsString,
    environment: Vec<(OsString, OsString)>,
    directory: PathBuf,
    exact_environment: bool,
    #[cfg(test)]
    pub(crate) hooks: super::test_hooks::Hooks,
}
impl InstalledCommand {
    pub(crate) fn from_service(
        program: &OsStr,
        environment: BTreeMap<OsString, OsString>,
        directory: PathBuf,
    ) -> Option<Self> {
        Self::from_snapshot(program, environment.into_iter().collect(), directory, false)
    }
    pub(crate) fn from_snapshot(
        program: &OsStr,
        environment: Vec<(OsString, OsString)>,
        directory: PathBuf,
        exact_environment: bool,
    ) -> Option<Self> {
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
            return None;
        }
        let argv0 = program.to_owned();
        let program = resolve(program, &environment, &directory)?;
        Some(Self {
            program,
            argv0,
            environment,
            directory,
            exact_environment,
            #[cfg(test)]
            hooks: super::test_hooks::Hooks::default(),
        })
    }
    pub(super) fn command(&self, arguments: &[OsString]) -> Command {
        let mut command = Command::new(&self.program);
        command.arg0(&self.argv0);
        command
            .args(arguments)
            .env_clear()
            .envs(self.environment.iter().map(|(key, value)| (key, value)))
            .current_dir(&self.directory)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }
    pub(super) fn configure_exact(
        &self,
        command: &mut Command,
        arguments: &[OsString],
    ) -> std::io::Result<()> {
        if self.exact_environment {
            let mut argv = Vec::with_capacity(arguments.len() + 1);
            argv.push(self.argv0.clone());
            argv.extend_from_slice(arguments);
            crate::native::ordered_exec::PreparedExec::new(
                &self.program,
                &argv,
                &self.environment,
            )?
            .configure(command);
        }
        Ok(())
    }
}
fn executable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
        && super::native::executable(path)
}
fn resolve(
    program: &OsStr,
    environment: &[(OsString, OsString)],
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
        .iter()
        .find(|(key, _)| key == OsStr::new("PATH"))
        .map_or(OsStr::new("/bin:/usr/bin"), |(_, value)| value.as_os_str());
    std::env::split_paths(search)
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
