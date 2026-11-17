use super::launcher::Environment;
use sha2::{Digest, Sha256};
use std::{
    ffi::{OsStr, OsString},
    fs::File,
    io::{self, Read},
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
const COMMANDS: &[&str] = &[
    "b", "bench", "build", "c", "check", "clean", "clippy", "doc", "fix", "metadata", "r", "run",
    "rustc", "rustdoc", "t", "test",
];

pub(super) fn select(
    cargo: &Path,
    arguments: &[OsString],
    environment: &Environment,
) -> Option<PathBuf> {
    if environment.get(OsStr::new("REVERIE_WORKER"))? != "1"
        || environment.contains_key(OsStr::new("CARGO_TARGET_DIR"))
        || environment.contains_key(OsStr::new("CARGO_BUILD_TARGET_DIR"))
    {
        return None;
    }
    let query = WorkspaceQuery::from_args(arguments)?;
    let cwd = std::env::current_dir().ok()?;
    if target_configured(&cwd, environment).ok()? {
        return None;
    }
    let workspace = query.locate(cargo, environment)?;
    let digest = format!("{:x}", Sha256::digest(workspace.as_os_str().as_bytes()));
    let temporary = environment
        .get(OsStr::new("TMPDIR"))
        .map(Path::new)
        .filter(|path| path.is_absolute())
        .unwrap_or(Path::new("/tmp"));
    Some(temporary.join("reverie/cargo-target").join(&digest[..24]))
}

struct WorkspaceQuery<'a> {
    toolchain: Option<&'a OsString>,
    manifest: Option<&'a OsStr>,
}

impl<'a> WorkspaceQuery<'a> {
    fn from_args(args: &'a [OsString]) -> Option<Self> {
        let (toolchain, args) = match args.split_first()? {
            (arg, rest) if arg.as_bytes().starts_with(b"+") => (Some(arg), rest),
            _ => (None, args),
        };
        let (subcommand, args) = args.split_first()?;
        if !COMMANDS.contains(&subcommand.to_str()?) {
            return None;
        }
        let mut options = args.iter().take_while(|arg| *arg != "--");
        let mut manifest = None;
        while let Some(option) = options.next() {
            let bytes = option.as_bytes();
            if overridden(bytes) {
                return None;
            }
            let value = if bytes == b"--manifest-path" {
                Some(options.next()?.as_os_str())
            } else {
                bytes
                    .strip_prefix(b"--manifest-path=")
                    .map(OsStr::from_bytes)
            };
            if let Some(value) = value
                && manifest.replace(value).is_some()
            {
                return None;
            }
        }
        Some(Self {
            toolchain,
            manifest,
        })
    }

    fn locate(&self, cargo: &Path, environment: &Environment) -> Option<PathBuf> {
        let mut command = Command::new(cargo);
        command
            .env_clear()
            .envs(environment)
            .args(self.toolchain)
            .args(["locate-project", "--workspace", "--message-format", "plain"])
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        if let Some(manifest) = self.manifest {
            command.arg("--manifest-path").arg(manifest);
        }
        let output = command.output().ok()?;
        let path = Path::new(OsStr::from_bytes(output.stdout.strip_suffix(b"\n")?));
        if !output.status.success() || !path.is_absolute() {
            return None;
        }
        path.parent()?.canonicalize().ok()
    }
}

fn overridden(option: &[u8]) -> bool {
    let name = option
        .split(|&byte| byte == b'=')
        .next()
        .unwrap_or_default();
    matches!(
        name,
        b"--target-dir" | b"--build-dir" | b"--config" | b"--help" | b"-h"
    ) || name.starts_with(b"-Z")
        || name.starts_with(b"-C")
}

fn target_configured(cwd: &Path, environment: &Environment) -> io::Result<bool> {
    let cargo_home = environment
        .get(OsStr::new("CARGO_HOME"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            environment
                .get(OsStr::new("HOME"))
                .map(|home| Path::new(home).join(".cargo"))
        });
    for directory in cwd
        .ancestors()
        .map(|path| path.join(".cargo"))
        .chain(cargo_home)
    {
        if overrides_target(&directory)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn overrides_target(directory: &Path) -> io::Result<bool> {
    for filename in ["config", "config.toml"] {
        let path = directory.join(filename);
        let metadata = match path.metadata() {
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            result => result?,
        };
        if !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut contents = String::new();
        File::open(&path)?
            .take(MAX_CONFIG_BYTES + 1)
            .read_to_string(&mut contents)?;
        if contents.len() as u64 > MAX_CONFIG_BYTES {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let config = contents.parse::<toml::Table>().map_err(io::Error::other)?;
        return Ok(config.contains_key("include")
            || config
                .get("build")
                .is_some_and(|build| build.get("target-dir").is_some()));
    }
    Ok(false)
}
