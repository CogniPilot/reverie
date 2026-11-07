use super::{approved, attribute, cache, key, path_text, settings};
use reverie_contracts::autoenv_environment::AutoenvEnvironment;
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    io,
    os::unix::{ffi::OsStrExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

type Environment = BTreeMap<OsString, OsString>;
struct Invocation {
    name: OsString,
    arguments: Vec<OsString>,
    executable: PathBuf,
    shim_directory: PathBuf,
}
impl Invocation {
    fn current(environment: &Environment) -> io::Result<Self> {
        let mut arguments = std::env::args_os();
        let invoked = PathBuf::from(arguments.next().ok_or(io::ErrorKind::InvalidInput)?);
        let name = invoked
            .file_name()
            .ok_or(io::ErrorKind::InvalidInput)?
            .to_owned();
        let executable = std::env::current_exe()?;
        let selected = if invoked.components().count() > 1 {
            invoked
        } else {
            std::env::split_paths(
                environment
                    .get(OsStr::new("PATH"))
                    .unwrap_or(&OsString::new()),
            )
            .map(|directory| directory.join(&name))
            .find(|candidate| std::fs::canonicalize(candidate).ok().as_ref() == Some(&executable))
            .ok_or_else(|| io::Error::other("cannot locate invoking tool symlink on PATH"))?
        };
        let shim_directory = std::fs::canonicalize(selected.parent().unwrap_or(Path::new(".")))?;
        Ok(Self {
            name,
            arguments: arguments.collect(),
            executable,
            shim_directory,
        })
    }
    fn strip_path(&self, value: &OsStr) -> OsString {
        let paths = std::env::split_paths(value).filter(|path| {
            let resolved = std::fs::canonicalize(if path.as_os_str().is_empty() {
                Path::new(".")
            } else {
                path.as_path()
            });
            resolved.ok().as_ref() != Some(&self.shim_directory)
        });
        std::env::join_paths(paths).expect("split PATH components contain no colon")
    }
    fn jobs(&self, environment: &mut Environment) {
        let commands = environment
            .get(OsStr::new("REVERIE_AUTOENV_JOBS_CMDS"))
            .filter(|v| !v.is_empty())
            .map_or(b"cargo".as_slice(), |s| s.as_bytes());
        if !commands
            .split(|&b| b == b',')
            .any(|name| name == self.name.as_bytes())
            || present(environment, "CARGO_BUILD_JOBS")
            || self.arguments.iter().any(|a| {
                a.as_bytes().starts_with(b"-j")
                    || a == "--jobs"
                    || a.as_bytes().starts_with(b"--jobs=")
            })
        {
            return;
        }
        let helper = environment
            .get(OsStr::new("REVERIE_JOBS_HELPER"))
            .filter(|value| !value.is_empty())
            .map_or(OsStr::new("reverie-build-jobs"), OsString::as_os_str);
        let output = Command::new(helper)
            .env_clear()
            .envs(&*environment)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        if let Ok(output) = output
            && output.status.success()
        {
            let mut value = output.stdout.as_slice();
            // Shell command substitution removed every trailing LF, not spaces.
            while let Some(prefix) = value.strip_suffix(b"\n") {
                value = prefix;
            }
            if !value.is_empty() && value != b"0" && value.iter().all(u8::is_ascii_digit) {
                environment.insert(
                    "CARGO_BUILD_JOBS".into(),
                    OsString::from(String::from_utf8(value.to_vec()).expect("ASCII digits")),
                );
            }
        }
    }
    fn exec(&self, environment: &Environment) -> io::Result<()> {
        let path = environment
            .get(OsStr::new("PATH"))
            .ok_or(io::ErrorKind::NotFound)?;
        let mut permission_denied = false;
        for directory in std::env::split_paths(path) {
            // A bare name would make Command perform another entire PATH
            // search, restarting an alias we already skipped. Empty entries
            // mean the current directory at this position, exactly once.
            let directory = if directory.as_os_str().is_empty() {
                Path::new(".")
            } else {
                directory.as_path()
            };
            let candidate = directory.join(&self.name);
            if std::fs::canonicalize(&candidate).ok().as_ref() == Some(&self.executable) {
                continue;
            }
            let error = Command::new(candidate)
                .arg0(&self.name)
                .args(&self.arguments)
                .env_clear()
                .envs(environment)
                .exec();
            match error.kind() {
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory => {}
                io::ErrorKind::PermissionDenied => permission_denied = true,
                _ => return Err(error),
            }
        }
        Err(if permission_denied {
            io::ErrorKind::PermissionDenied
        } else {
            io::ErrorKind::NotFound
        }
        .into())
    }
}
fn present(environment: &Environment, name: &str) -> bool {
    environment
        .get(OsStr::new(name))
        .is_some_and(|value| !value.is_empty())
}
fn repository() -> Option<PathBuf> {
    let mut directory = std::env::current_dir().ok()?;
    while directory.parent().is_some() {
        if directory.join("flake.nix").is_file() && directory.join(".git").exists() {
            return Some(directory);
        }
        directory.pop();
    }
    None
}
fn activate(invocation: &Invocation, environment: &mut Environment) -> super::Result<()> {
    let Some(repository) = repository() else {
        return Ok(());
    };
    let settings = settings()?;
    if !settings.config.exists() {
        return Ok(());
    }
    let Some(approval) = approved(&repository, &settings.config)? else {
        return Ok(());
    };
    if !approval.allows_command(path_text(Path::new(&invocation.name)).as_text_ref()) {
        return Ok(());
    }
    let attribute = attribute(&approval)?;
    let key = key(&repository, &attribute)?;
    let raw = cache::read(&settings.cache, &key).map_err(|error| format!("no readable cache for {} ({attribute}, key {key}): {error}; build it with reverie-autoenv build {}", repository.display(), repository.display()))?;
    let cached = AutoenvEnvironment::from_cache(&raw)?;
    let base = environment
        .get(OsStr::new("PATH"))
        .cloned()
        .unwrap_or_default();
    let mut selected = environment.clone();
    selected.extend(
        cached
            .assignments()
            .map(|(name, value)| (name.into(), value.into())),
    );
    let mut path = selected
        .get(OsStr::new("PATH"))
        .cloned()
        .unwrap_or_default();
    path.push(":");
    path.push(base);
    selected.insert("PATH".into(), invocation.strip_path(&path));
    selected.insert("REVERIE_AUTOENV_ACTIVE".into(), key.into());
    *environment = selected;
    Ok(())
}
pub(super) fn launch() -> io::Result<()> {
    let mut environment: Environment = std::env::vars_os().collect();
    let invocation = Invocation::current(&environment)?;
    let path = environment
        .get(OsStr::new("PATH"))
        .cloned()
        .unwrap_or_default();
    environment.insert("PATH".into(), invocation.strip_path(&path));
    if environment
        .get(OsStr::new("REVERIE_NO_AUTOENV"))
        .is_some_and(|value| value == "1")
    {
        return invocation.exec(&environment);
    }
    if !present(&environment, "IN_NIX_SHELL")
        && !present(&environment, "REVERIE_AUTOENV_ACTIVE")
        && let Err(error) = activate(&invocation, &mut environment)
        && !present(&environment, "REVERIE_AUTOENV_QUIET")
    {
        eprintln!("reverie-autoenv: {error}; using plain tool");
    }
    invocation.jobs(&mut environment);
    invocation.exec(&environment)
}
