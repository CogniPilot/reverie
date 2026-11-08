//! Nix-managed host inference. Only a private Unix socket crosses the container boundary.
//!
//! `reverie-local-model` builds llama.cpp through Nix for the selected NVIDIA GPU (or the CPU),
//! keeps a private API key beside the model's control socket, and then either execs
//! `llama-server` or installs a systemd user service that runs this launcher again from its saved
//! configuration. Every external program goes through [`Runner`], so tests drive the whole flow
//! without a GPU, Docker, Nix or systemd.
use std::ffi::OsString;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub mod args;
pub use args::{Args, SamplingProfile, Usage};

/// A refusal or failure, printed as `reverie-local-model: <message>` with exit status 1.
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

/// Which of a command's output streams are captured; the rest go to the launcher's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Capture {
    /// stdout and stderr captured; stdout returned.
    All,
    /// stdout captured and returned; stderr shown.
    Stdout,
    /// Both shown; nothing returned.
    None,
}

/// The external programs the launcher runs. `env` is what the launcher added to its own
/// environment so far, applied on top of the inherited one.
pub trait Runner {
    /// Runs `argv` to completion; a non-zero exit is an error.
    fn run(
        &mut self,
        argv: &[String],
        capture: Capture,
        env: &[(String, String)],
    ) -> Result<String, Error>;
    /// Replaces the launcher with `program` (shown as `llama-server`) under umask 077. Returns
    /// only on failure in the real runner.
    fn exec(&mut self, program: &Path, args: &[String], env: &[(String, String)]) -> Error;
}

/// What the launcher reads from its surroundings.
#[derive(Clone, Debug)]
pub struct Host {
    pub home: PathBuf,
    /// The launcher's environment as given.
    pub env: Vec<(String, String)>,
    /// NixOS keeps the real host driver outside the immutable CUDA toolkit closure.
    pub driver: PathBuf,
}

impl Host {
    fn var(&self, name: &str) -> Option<&str> {
        self.env
            .iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    fn required(&self, name: &str) -> Result<&str, Error> {
        self.var(name)
            .ok_or_else(|| Error(format!("{name} is not set")))
    }

    fn expand(&self, path: &str) -> PathBuf {
        match path.strip_prefix('~') {
            Some("") => self.home.clone(),
            Some(rest) if rest.starts_with('/') => self.home.join(&rest[1..]),
            _ => PathBuf::from(path),
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

fn digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn compute_capability(value: &str) -> bool {
    value
        .split_once('.')
        .is_some_and(|(major, minor)| digits(major) && digits(minor))
}

/// A name that starts with an ASCII letter or digit and continues with those or `_.-`.
fn simple_name(value: &str, max: usize) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && value.len() <= max
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}

/// The compute capability of NVIDIA device `gpu` (an index), or empty for `cpu`.
pub fn gpu_capability(runner: &mut dyn Runner, gpu: &str) -> Result<String, Error> {
    if gpu == "cpu" {
        return Ok(String::new());
    }
    if !digits(gpu) {
        return refuse("--gpu is an NVIDIA device index, or cpu");
    }
    let argv = [
        "nvidia-smi",
        "--query-gpu=index,compute_cap",
        "--format=csv,noheader",
    ]
    .map(str::to_owned);
    let table = runner.run(&argv, Capture::All, &[])?;
    for row in table.lines() {
        let fields: Vec<&str> = row.split(',').map(str::trim).collect();
        if let [index, capability] = fields.as_slice()
            && *index == gpu
            && compute_capability(capability)
        {
            return Ok((*capability).to_owned());
        }
    }
    refuse("Selected GPU was not found or its compute capability is unknown")
}

/// The host side of the one read-write bind of `/run/reverie-control` into container `name`.
pub fn container_control(runner: &mut dyn Runner, name: &str) -> Result<PathBuf, Error> {
    if !simple_name(name, usize::MAX) {
        return refuse("Invalid container name");
    }
    let argv = ["docker".to_owned(), "inspect".to_owned(), name.to_owned()];
    let inspected: serde_json::Value =
        serde_json::from_str(&runner.run(&argv, Capture::All, &[])?)
            .map_err(|error| Error(format!("docker inspect: {error}")))?;
    let mounts = inspected[0]["Mounts"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let binds: Vec<&str> = mounts
        .iter()
        .filter(|mount| {
            mount["Destination"] == "/run/reverie-control"
                && mount["Type"] == "bind"
                && mount["RW"] == true
        })
        .filter_map(|mount| mount["Source"].as_str())
        .collect();
    match binds.as_slice() {
        [source] => Ok(PathBuf::from(source)),
        _ => refuse(
            "The container needs the owner-selected /run/reverie-control bind from reverie-start",
        ),
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

/// A systemd unit-file word: quoted, with specifiers and variables escaped.
pub fn unit_quote(value: &str) -> Result<String, Error> {
    if value.contains(['\n', '\r', '\0']) {
        return refuse("Invalid service path");
    }
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%")
        .replace('$', "$$");
    Ok(format!("\"{escaped}\""))
}

/// The saved operator configuration, in the order the launcher writes it.
pub fn saved_config(
    args: &Args,
    model: &Path,
    projector: Option<&Path>,
) -> Vec<(&'static str, serde_json::Value)> {
    use serde_json::Value;
    let mut config = vec![
        ("model", Value::from(model.to_string_lossy())),
        ("alias", Value::from(args.alias.as_str())),
        ("gpu", Value::from(args.gpu.as_str())),
        ("context", Value::from(args.context)),
        ("port", Value::from(args.port)),
    ];
    if let Some(projector) = projector {
        config.push(("mmproj", Value::from(projector.to_string_lossy())));
        config.push(("image-max-tokens", Value::from(args.image_max_tokens)));
    }
    if args.sampling_profile != SamplingProfile::ServerDefault {
        config.push((
            "sampling-profile",
            Value::from(args.sampling_profile.name()),
        ));
    }
    if let Some(container) = &args.container {
        config.push(("container", Value::from(container.as_str())));
    }
    config
}

/// JSON with two-space indentation and the given key order.
fn json_object(entries: &[(&str, serde_json::Value)]) -> String {
    let body: Vec<String> = entries
        .iter()
        .map(|(key, value)| format!("  {}: {value}", serde_json::Value::from(*key)))
        .collect();
    format!("{{\n{}\n}}", body.join(",\n"))
}

/// Saves `config`, writes the user unit that reruns the launcher from it, and enables it.
pub fn install_service(
    runner: &mut dyn Runner,
    host: &Host,
    config: &[(&str, serde_json::Value)],
) -> Result<(), Error> {
    let directory = host.home.join(".config/reverie");
    private_dir(&directory)?;
    let config_path = directory.join("local-model.json");
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&config_path)?;
    file.write_all(json_object(config).as_bytes())?;
    let units = host.home.join(".config/systemd/user");
    fs::create_dir_all(&units)?;
    let launcher = host.required("REVERIE_MODEL_LAUNCHER")?;
    let unit = format!(
        "[Unit]\nDescription=Reverie local model (Nix)\n\
         [Service]\nType=simple\nUMask=0077\n\
         ExecStart={} --config {}\n\
         Restart=on-failure\nRestartSec=5\nTimeoutStopSec=30\n\
         [Install]\nWantedBy=default.target\n",
        unit_quote(launcher)?,
        unit_quote(&config_path.to_string_lossy())?
    );
    fs::write(units.join("reverie-local-model.service"), unit)?;
    let systemctl = |words: &[&str]| -> Vec<String> {
        ["systemctl", "--user"]
            .iter()
            .chain(words)
            .map(|word| (*word).to_owned())
            .collect()
    };
    runner.run(&systemctl(&["daemon-reload"]), Capture::None, &[])?;
    runner.run(
        &systemctl(&["enable", "--now", "reverie-local-model.service"]),
        Capture::None,
        &[],
    )?;
    println!("Local model service enabled. View logs: journalctl --user -u reverie-local-model -f");
    Ok(())
}

/// Where the model's files live and how its server is reached.
struct Layout {
    model: PathBuf,
    projector: Option<PathBuf>,
    capability: String,
    reverie_root: PathBuf,
    env: Vec<(String, String)>,
}

fn regular_file(host: &Host, path: &str) -> Result<PathBuf, Error> {
    fs::canonicalize(host.expand(path)).map_err(|error| Error(format!("{path}: {error}")))
}

fn validate(runner: &mut dyn Runner, host: &Host, args: &Args) -> Result<Layout, Error> {
    let model = regular_file(host, args.model.as_deref().unwrap_or_default())?;
    if !model.is_file() || !simple_name(&args.alias, 100) {
        return refuse("Choose a regular GGUF model and a simple model alias");
    }
    if !(512..=262_144).contains(&args.context) || !(1..=65_535).contains(&args.port) {
        return refuse("Invalid context size or port");
    }
    let projector = args
        .mmproj
        .as_deref()
        .map(|path| regular_file(host, path))
        .transpose()?;
    if projector.as_ref().is_some_and(|path| !path.is_file()) {
        return refuse("Choose a regular vision projector GGUF");
    }
    if !(128..=8192).contains(&args.image_max_tokens) {
        return refuse("Invalid image token budget");
    }
    let capability = gpu_capability(runner, &args.gpu)?;
    let reverie_root = match host.var("REVERIE_ROOT").filter(|root| !root.is_empty()) {
        Some(root) => host.expand(root),
        None => host.home.join("reverie"),
    };
    Ok(Layout {
        model,
        projector,
        capability,
        reverie_root,
        env: Vec::new(),
    })
}

/// Prepares the build scratch and the environment every later command and the server inherit.
fn scratch_environment(host: &Host, layout: &mut Layout, gpu: &str) -> Result<PathBuf, Error> {
    let scratch = match host.var("REVERIE_MODEL_SCRATCH") {
        Some(path) => PathBuf::from(path),
        None => host.home.join("scratch/reverie/models"),
    };
    fs::create_dir_all(&scratch)?;
    let scratch = fs::canonicalize(scratch)?;
    let build_dir = scratch.join("nix-build");
    match fs::DirBuilder::new().mode(0o755).create(&build_dir) {
        Err(error) if error.kind() != io::ErrorKind::AlreadyExists => return Err(error.into()),
        _ => fs::set_permissions(&build_dir, fs::Permissions::from_mode(0o755))?,
    }
    for directory in ["cache", "tmp"] {
        match fs::create_dir(scratch.join(directory)) {
            Err(error) if error.kind() != io::ErrorKind::AlreadyExists => return Err(error.into()),
            _ => {}
        }
    }
    let path = |name: &str| scratch.join(name).to_string_lossy().into_owned();
    let mut env = vec![
        ("TMPDIR".to_owned(), path("tmp")),
        ("LLAMA_CACHE".to_owned(), path("cache")),
    ];
    env.push((
        "NIX_BUILD_CORES".to_owned(),
        host.var("NIX_BUILD_CORES").unwrap_or("4").to_owned(),
    ));
    if !layout.capability.is_empty() {
        env.push(("CUDA_VISIBLE_DEVICES".to_owned(), gpu.to_owned()));
    }
    if host.driver.is_dir() {
        let driver = host.driver.to_string_lossy().into_owned();
        let library = match host
            .var("LD_LIBRARY_PATH")
            .filter(|value| !value.is_empty())
        {
            Some(existing) => format!("{driver}:{existing}"),
            None => driver,
        };
        env.push(("LD_LIBRARY_PATH".to_owned(), library));
    }
    layout.env = env;
    Ok(build_dir)
}

/// Builds the llama.cpp runtime for the selected capability and returns its store path.
fn build_runtime(
    runner: &mut dyn Runner,
    host: &Host,
    layout: &Layout,
    build_dir: &Path,
) -> Result<PathBuf, Error> {
    let runtime_root = layout.reverie_root.join("runtime/local-model/runtime");
    if let Some(parent) = runtime_root.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut argv: Vec<String> = ["nix", "build", "--out-link"].map(str::to_owned).to_vec();
    argv.push(runtime_root.to_string_lossy().into_owned());
    argv.extend(["--print-out-paths", "--file"].map(str::to_owned));
    argv.push(host.required("REVERIE_MODEL_BUILD_EXPR")?.to_owned());
    argv.extend([
        "--argstr".to_owned(),
        "nixpkgs".to_owned(),
        host.required("REVERIE_MODEL_NIXPKGS")?.to_owned(),
    ]);
    argv.extend([
        "--argstr".to_owned(),
        "system".to_owned(),
        host.required("REVERIE_MODEL_SYSTEM")?.to_owned(),
    ]);
    argv.extend([
        "--argstr".to_owned(),
        "capability".to_owned(),
        layout.capability.clone(),
    ]);
    argv.extend([
        "--option".to_owned(),
        "build-dir".to_owned(),
        build_dir.to_string_lossy().into_owned(),
    ]);
    let target = if layout.capability.is_empty() {
        "CPU".to_owned()
    } else {
        format!("CUDA {}", layout.capability)
    };
    println!("Preparing Nix llama.cpp for {target}; first build may take time.");
    Ok(PathBuf::from(
        runner.run(&argv, Capture::Stdout, &layout.env)?.trim(),
    ))
}

/// The server's arguments after the program name.
fn server_args(args: &Args, layout: &Layout, address: &str, key: &Path) -> Vec<String> {
    let mut argv: Vec<String> = vec![
        "--model".into(),
        layout.model.to_string_lossy().into_owned(),
        "--alias".into(),
        args.alias.clone(),
        "--host".into(),
        address.to_owned(),
        "--port".into(),
        args.port.to_string(),
        "--ctx-size".into(),
        args.context.to_string(),
    ];
    let gpu_layers = if layout.capability.is_empty() {
        "0"
    } else {
        "all"
    };
    let fixed = [
        "--parallel",
        "1",
        "--threads",
        "8",
        "--gpu-layers",
        gpu_layers,
        "--flash-attn",
        "on",
    ];
    argv.extend(fixed.map(str::to_owned));
    argv.extend(
        [
            "--cache-type-k",
            "q8_0",
            "--cache-type-v",
            "q8_0",
            "--api-key-file",
        ]
        .map(str::to_owned),
    );
    argv.push(key.to_string_lossy().into_owned());
    argv.extend(sampling_args(args.sampling_profile));
    if let Some(projector) = &layout.projector {
        argv.extend([
            "--mmproj".to_owned(),
            projector.to_string_lossy().into_owned(),
        ]);
        argv.extend([
            "--image-max-tokens".to_owned(),
            args.image_max_tokens.to_string(),
        ]);
    }
    argv
}

/// Runs the launcher with already-parsed `args`. Returns only after installing the service, or
/// when the final exec failed.
pub fn launch(runner: &mut dyn Runner, host: &Host, args: &Args) -> Result<(), Error> {
    let mut layout = validate(runner, host, args)?;
    let build_dir = scratch_environment(host, &mut layout, &args.gpu)?;
    let runtime = build_runtime(runner, host, &layout, &build_dir)?;
    let control = match &args.container {
        Some(name) => container_control(runner, name)?,
        None => layout.reverie_root.join("runtime/local-model/control"),
    };
    let private = control.join("models");
    private_dir(&private)?;
    fs::set_permissions(&private, fs::Permissions::from_mode(0o700))?;
    let key = private.join("api-key");
    private_key(&key)?;
    let socket = private.join("default.sock");
    let address = if args.container.is_some() {
        if socket.as_os_str().len() > 100 {
            return refuse("Control mount path is too long for a Unix socket");
        }
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(private.join("enabled"))?;
        println!(
            "Container endpoint: http://127.0.0.1:8092 (API key stays in the private models/api-key file)."
        );
        socket.to_string_lossy().into_owned()
    } else {
        println!(
            "Native endpoint: http://127.0.0.1:{}; API key file: {}",
            args.port,
            key.display()
        );
        "127.0.0.1".to_owned()
    };
    if args.install_service {
        let config = saved_config(args, &layout.model, layout.projector.as_deref());
        return install_service(runner, host, &config);
    }
    if args.container.is_some() {
        prepare_socket(&socket)?;
    }
    let server = server_args(args, &layout, &address, &key);
    Err(runner.exec(&runtime.join("bin/llama-server"), &server, &layout.env))
}

/// Parses `argv` (without the program name), follows `--config`, and launches.
pub fn main_with(runner: &mut dyn Runner, host: &Host, argv: &[OsString]) -> Result<(), Usage> {
    let args = args::parse(argv)?;
    let args = match &args.config {
        Some(path) => args::from_config(Path::new(path))?,
        None => args,
    };
    if args.model.is_none() {
        return Err(Usage::Invalid("--model is required".into()));
    }
    launch(runner, host, &args).map_err(Usage::Failed)
}
