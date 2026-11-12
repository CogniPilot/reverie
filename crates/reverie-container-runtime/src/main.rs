//! Docker-owned supervision for the website, local inference and GPU telemetry.
//! The container never invokes Nix, Docker, systemctl or a host executable.
mod config;

use config::{Model, Result};
use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use std::ffi::OsString;
use std::fs::{self, DirBuilder};
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::process::{ExitCode, ExitStatus};
use std::time::Duration;
use tokio::process::{Child, Command};
use tokio::signal::unix::{SignalKind, signal};

struct RuntimeDirectory(PathBuf);

impl RuntimeDirectory {
    fn new() -> Result<Self> {
        let mut random = [0_u8; 12];
        getrandom::getrandom(&mut random).map_err(|error| error.to_string())?;
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let path = std::env::temp_dir().join(format!("reverie-container-{suffix}"));
        DirBuilder::new().mode(0o700).create(&path)?;
        Ok(Self(path))
    }
}

impl Drop for RuntimeDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn program(variable: &str) -> Result<OsString> {
    std::env::var_os(variable).ok_or_else(|| format!("{variable} is missing from the image").into())
}

fn inference(model: &Model) -> Result<Child> {
    reverie_local_model::private_key(&model.key).map_err(|error| error.to_string())?;
    DirBuilder::new().recursive(true).mode(0o700).create(
        model
            .socket
            .parent()
            .ok_or("model socket needs a parent directory")?,
    )?;
    reverie_local_model::prepare_socket(&model.socket).map_err(|error| error.to_string())?;
    let mut server = Command::new(program("REVERIE_LLAMA_SERVER")?);
    server
        .arg("--model")
        .arg(model.args.model.as_deref().ok_or("model is required")?)
        .arg("--alias")
        .arg(&model.args.alias)
        .arg("--host")
        .arg(&model.socket)
        .arg("--port")
        .arg(model.port.to_string())
        .arg("--ctx-size")
        .arg(model.args.context.to_string())
        .args(["--parallel", "1", "--threads", "8", "--gpu-layers"])
        .arg(&model.layers)
        .args(["--flash-attn", "auto", "--cache-type-k"])
        .arg(model.cache_type())
        .arg("--cache-type-v")
        .arg(model.cache_type())
        .arg("--api-key-file")
        .arg(&model.key)
        .args(reverie_local_model::sampling_args(
            model.args.sampling_profile,
        ))
        .kill_on_drop(true);
    if let Some(projector) = &model.args.mmproj {
        server
            .arg("--mmproj")
            .arg(projector)
            .arg("--image-max-tokens")
            .arg(model.args.image_max_tokens.to_string());
    }
    if let Some(driver) = std::env::var_os("NVIDIA_CTK_LIBCUDA_DIR") {
        let mut paths = vec![PathBuf::from(driver)];
        if let Some(previous) = std::env::var_os("LD_LIBRARY_PATH") {
            paths.extend(std::env::split_paths(&previous));
        }
        server.env("LD_LIBRARY_PATH", std::env::join_paths(paths)?);
    }
    Ok(server.spawn()?)
}

fn model_relay(model: &Model) -> Result<Child> {
    Ok(Command::new(program("REVERIE_MODEL_RELAY")?)
        .arg(program("REVERIE_MODEL_RELAY_SCRIPT")?)
        .env("REVERIE_MODEL_SOCKET", &model.socket)
        .env("REVERIE_MODEL_PORT", model.port.to_string())
        .env("REVERIE_CONTAINER_RELAY", "1")
        .kill_on_drop(true)
        .spawn()?)
}

async fn optional_exit(child: &mut Option<Child>) -> std::io::Result<ExitStatus> {
    match child {
        Some(child) => child.wait().await,
        None => std::future::pending().await,
    }
}

async fn stop(child: &mut Child) {
    if let Some(id) = child.id().and_then(|id| i32::try_from(id).ok()) {
        let _ = kill(Pid::from_raw(id), Signal::SIGTERM);
    }
    if tokio::time::timeout(Duration::from_secs(25), child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
}

async fn run() -> Result<i32> {
    let mut arguments = std::env::args_os().skip(1);
    let web_program = arguments.next().ok_or("a website entrypoint is required")?;
    if web_program == "--help" {
        println!(
            "reverie-container-runtime ENTRYPOINT [ARGS...]\nDocker supervises the website, optional local model and GPU telemetry. See docs/container-gpu.md."
        );
        return Ok(0);
    }
    let model = Model::from_env()?;
    nix::sys::stat::umask(nix::sys::stat::Mode::from_bits_truncate(0o077));
    let directory = RuntimeDirectory::new()?;
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut server = model.as_ref().map(inference).transpose()?;
    let mut relay = model.as_ref().map(model_relay).transpose()?;
    let telemetry_file = directory.0.join("gpu.json");
    let mut telemetry = Command::new(program("REVERIE_GPU_PUBLISHER")?)
        .arg("--output")
        .arg(&telemetry_file)
        .kill_on_drop(true)
        .spawn()?;
    let mut website = Command::new(web_program)
        .args(arguments)
        .env("REVERIE_GPU_STATUS_FILE", &telemetry_file)
        .env("REVERIE_MODEL_RELAY_MANAGED", "1")
        .kill_on_drop(true)
        .spawn()?;
    let result = tokio::select! {
        result = website.wait() => result?.code().unwrap_or(1),
        result = optional_exit(&mut server) => { eprintln!("local inference exited: {}", result?); 1 },
        result = optional_exit(&mut relay) => { eprintln!("local model relay exited: {}", result?); 1 },
        result = telemetry.wait() => { eprintln!("GPU telemetry exited: {}", result?); 1 },
        _ = terminate.recv() => 0,
        _ = interrupt.recv() => 0,
    };
    let stop_server = async {
        if let Some(server) = &mut server {
            stop(server).await;
        }
    };
    let stop_relay = async {
        if let Some(relay) = &mut relay {
            stop(relay).await;
        }
    };
    tokio::join!(
        stop(&mut website),
        stop(&mut telemetry),
        stop_server,
        stop_relay
    );
    Ok(result)
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    match run().await {
        Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
        Err(error) => {
            eprintln!("reverie-container-runtime: {error}");
            ExitCode::FAILURE
        }
    }
}
