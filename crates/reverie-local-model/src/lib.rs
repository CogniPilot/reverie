//! Credential custody, socket recovery and sampling presets for container inference.
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

/// A local model configuration or custody failure.
#[derive(Debug)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Self(error.to_string())
    }
}

fn refuse<T>(message: &str) -> Result<T, Error> {
    Err(Error(message.to_owned()))
}

/// An explicit model-vendor sampling preset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SamplingProfile {
    ServerDefault,
    Qwen38Thinking,
}

impl FromStr for SamplingProfile {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "server-default" => Ok(Self::ServerDefault),
            "qwen3.8-thinking" => Ok(Self::Qwen38Thinking),
            _ => refuse("model sampling profile must be server-default or qwen3.8-thinking"),
        }
    }
}

/// The server arguments for an explicit model-vendor sampling profile.
pub fn sampling_args(profile: SamplingProfile) -> Vec<String> {
    match profile {
        SamplingProfile::ServerDefault => Vec::new(),
        // https://huggingface.co/Qwen/Qwen3.8-27B#best-practices
        SamplingProfile::Qwen38Thinking => [
            "--jinja",
            "--reasoning",
            "on",
            "--temp",
            "1.0",
            "--top-p",
            "0.95",
            "--top-k",
            "20",
            "--min-p",
            "0.0",
            "--presence-penalty",
            "0.0",
            "--repeat-penalty",
            "1.0",
            "--chat-template-kwargs",
            r#"{"reasoning_effort": "xhigh", "preserve_thinking": true}"#,
        ]
        .map(str::to_owned)
        .to_vec(),
    }
}

fn private_dir(path: &Path) -> io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}

/// Creates the API key at `path` once (32 random bytes as hex) and requires an owned private
/// regular file there afterwards. A symlink is never followed into.
pub fn private_key(path: &Path) -> Result<(), Error> {
    if let Some(parent) = path.parent() {
        private_dir(parent)?;
    }
    if !path.exists() {
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).map_err(|error| Error(error.to_string()))?;
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(format!("{hex}\n").as_bytes())?;
    }
    let info = fs::symlink_metadata(path)?;
    if !info.is_file() || info.mode() & 0o077 != 0 || info.uid() != nix::unistd::getuid().as_raw() {
        return refuse("Model API key must be an owned private regular file (mode 0600)");
    }
    Ok(())
}

/// Recovers an owned, private socket whose listener is gone, without ever replacing a live
/// listener or anything that is not such a socket.
pub fn prepare_socket(path: &Path) -> Result<(), Error> {
    use std::os::unix::fs::FileTypeExt;
    let previous = match fs::symlink_metadata(path) {
        Ok(info) => info,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !previous.file_type().is_socket()
        || previous.uid() != nix::unistd::getuid().as_raw()
        || previous.mode() & 0o077 != 0
    {
        return refuse("Model socket must be an owned private socket");
    }
    let probe = socket2::Socket::new(socket2::Domain::UNIX, socket2::Type::STREAM, None)?;
    match probe.connect_timeout(&socket2::SockAddr::unix(path)?, Duration::from_secs(1)) {
        Ok(()) => refuse("The local model socket already has a listener"),
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => {
            let current = fs::symlink_metadata(path)?;
            if (previous.dev(), previous.ino()) != (current.dev(), current.ino()) {
                return refuse("Model socket changed during startup");
            }
            fs::remove_file(path)?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}
