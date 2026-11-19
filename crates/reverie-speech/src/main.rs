//! Docker loopback speech service for the Office voice routes.
use clap::Parser;
use reverie_speech::{Configuration, Whisper, serve};
use std::{env, net::Ipv4Addr, path::PathBuf, process::ExitCode, time::Duration};
use tokio::net::TcpListener;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Parser)]
#[command(about = "Serve the Office speech endpoints using installed Whisper and Piper models.")]
struct Options {
    /// Existing voice asset directory. Defaults to REVERIE_VOICE_DIR or the console data directory.
    #[arg(long)]
    models: Option<PathBuf>,
    /// Override the loopback port for an isolated development service.
    #[arg(long, default_value_t = 8090)]
    port: u16,
}

fn program(setting: &str, installed: Option<&str>, fallback: &str) -> PathBuf {
    env::var_os(setting)
        .filter(|value| !value.is_empty())
        .map_or_else(
            || PathBuf::from(installed.unwrap_or(fallback)),
            PathBuf::from,
        )
}

fn models() -> PathBuf {
    if let Some(directory) = env::var_os("REVERIE_VOICE_DIR") {
        return directory.into();
    }
    env::var_os("REVERIE_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/instances/default/console"))
        .join("voice")
}

fn configure(options: Options) -> Result<Configuration> {
    let models = std::path::absolute(options.models.unwrap_or_else(models))?;
    let model = env::var("REVERIE_WHISPER_MODEL").unwrap_or_else(|_| "base.en".into());
    if !(1..=64).contains(&model.len())
        || !model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    {
        return Err("Invalid Whisper model name".into());
    }
    let scratch = env::temp_dir();
    let whisper = Whisper::new(
        program(
            "REVERIE_FFMPEG_BIN",
            option_env!("REVERIE_SPEECH_FFMPEG"),
            "ffmpeg",
        ),
        program(
            "REVERIE_WHISPER_BIN",
            option_env!("REVERIE_SPEECH_WHISPER"),
            "whisper-cli",
        ),
        models.join(format!("ggml-{model}.bin")),
        scratch.clone(),
        env::var("REVERIE_WHISPER_THREADS").map_or(Ok(4), |value| value.parse())?,
    )?;
    let ttl = env::var("REVERIE_AUDIO_TTL").map_or(Ok(3600), |value| value.parse::<u64>())?;
    Ok(Configuration {
        whisper,
        piper: program(
            "REVERIE_PIPER_BIN",
            option_env!("REVERIE_SPEECH_PIPER"),
            "piper",
        ),
        models,
        scratch,
        voice: env::var("REVERIE_VOICE").unwrap_or_else(|_| "en_US-amy-medium".into()),
        audio_ttl: Duration::from_secs(ttl.min(86_400)),
    })
}

async fn run(options: Options) -> Result<()> {
    let socket = TcpListener::bind((Ipv4Addr::LOCALHOST, options.port)).await?;
    let config = configure(options)?;
    eprintln!(
        "Reverie speech listening on http://{}",
        socket.local_addr()?
    );
    serve(socket, config).await
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(Options::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("reverie-speech: {error}");
            ExitCode::FAILURE
        }
    }
}
