//! The launcher's command line and its saved configuration, which is the same options as JSON.
use crate::Error;
use std::ffi::OsString;
use std::path::Path;

pub const USAGE: &str =
    "usage: reverie-local-model [-h] [--model MODEL] [--alias ALIAS] [--mmproj MMPROJ]
                           [--image-max-tokens N] [--gpu GPU] [--context N]
                           [--sampling-profile {server-default,qwen3.8-thinking}]
                           [--container CONTAINER] [--port PORT] [--install-service]
                           [--config CONFIG]";

const HELP: &str = "
Nix-managed host inference. Only a private Unix socket crosses the container boundary.

options:
  -h, --help            show this help message and exit
  --model MODEL         Existing GGUF weights; never rewritten or downloaded implicitly
  --alias ALIAS         (default: local-model)
  --mmproj MMPROJ       Existing matching vision projector GGUF; never downloaded implicitly
  --image-max-tokens N  Bound dynamic-resolution image tokens (default: 2048)
  --gpu GPU             NVIDIA device index, or cpu (default: 0)
  --context N           (default: 32768)
  --sampling-profile {server-default,qwen3.8-thinking}
                        Explicit model-vendor sampling defaults
  --container CONTAINER
                        Reverie container; inference is reachable through its private control mount
  --port PORT           Native-only loopback port (default: 8080)
  --install-service
  --config CONFIG       Saved operator configuration";

/// An explicit model-vendor sampling preset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SamplingProfile {
    ServerDefault,
    Qwen38Thinking,
}

impl SamplingProfile {
    /// The profile's command-line spelling.
    pub fn name(self) -> &'static str {
        match self {
            Self::ServerDefault => "server-default",
            Self::Qwen38Thinking => "qwen3.8-thinking",
        }
    }
}

/// The parsed options, with the launcher's defaults.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Args {
    pub model: Option<String>,
    pub alias: String,
    pub mmproj: Option<String>,
    pub image_max_tokens: i64,
    pub gpu: String,
    pub context: i64,
    pub sampling_profile: SamplingProfile,
    pub container: Option<String>,
    pub port: i64,
    pub install_service: bool,
    pub config: Option<String>,
}

impl Default for Args {
    fn default() -> Self {
        Self {
            model: None,
            alias: "local-model".into(),
            mmproj: None,
            image_max_tokens: 2048,
            gpu: "0".into(),
            context: 32768,
            sampling_profile: SamplingProfile::ServerDefault,
            container: None,
            port: 8080,
            install_service: false,
            config: None,
        }
    }
}

/// Why the launcher stops before or while running.
#[derive(Debug)]
pub enum Usage {
    /// `--help`: the text to print, then exit 0.
    Help(String),
    /// A command-line error: usage and message to stderr, exit 2.
    Invalid(String),
    /// A refusal or failure: message to stderr, exit 1.
    Failed(Error),
}

fn integer(option: &str, value: &str) -> Result<i64, Usage> {
    value
        .trim()
        .parse()
        .map_err(|_| Usage::Invalid(format!("argument {option}: invalid int value: '{value}'")))
}

fn profile(value: &str) -> Result<SamplingProfile, Usage> {
    match value {
        "server-default" => Ok(SamplingProfile::ServerDefault),
        "qwen3.8-thinking" => Ok(SamplingProfile::Qwen38Thinking),
        _ => Err(Usage::Invalid(format!(
            "argument --sampling-profile: invalid choice: '{value}' \
             (choose from server-default, qwen3.8-thinking)"
        ))),
    }
}

fn set(args: &mut Args, option: &str, value: String) -> Result<(), Usage> {
    match option {
        "--model" => args.model = Some(value),
        "--alias" => args.alias = value,
        "--mmproj" => args.mmproj = Some(value),
        "--image-max-tokens" => args.image_max_tokens = integer(option, &value)?,
        "--gpu" => args.gpu = value,
        "--context" => args.context = integer(option, &value)?,
        "--sampling-profile" => args.sampling_profile = profile(&value)?,
        "--container" => args.container = Some(value),
        "--port" => args.port = integer(option, &value)?,
        "--config" => args.config = Some(value),
        _ => return Err(Usage::Invalid(format!("unrecognized arguments: {option}"))),
    }
    Ok(())
}

/// The option and its value, from `--name=value` or from `--name` and the next word.
fn option_value(
    word: &str,
    rest: &mut impl Iterator<Item = String>,
) -> Result<(String, String), Usage> {
    if let Some((option, value)) = word.split_once('=') {
        return Ok((option.to_owned(), value.to_owned()));
    }
    let value = rest
        .next()
        .ok_or_else(|| Usage::Invalid(format!("argument {word}: expected one argument")))?;
    Ok((word.to_owned(), value))
}

/// Parses `argv` without the program name. Each option takes `--name value` or `--name=value`;
/// a later repeat wins.
pub fn parse(argv: &[OsString]) -> Result<Args, Usage> {
    let mut args = Args::default();
    let mut words = argv.iter().map(|word| word.to_string_lossy().into_owned());
    while let Some(word) = words.next() {
        match word.as_str() {
            "-h" | "--help" => return Err(Usage::Help(format!("{USAGE}\n{HELP}"))),
            "--install-service" => args.install_service = true,
            _ if word.starts_with("--") => {
                let (option, value) = option_value(&word, &mut words)?;
                set(&mut args, &option, value)?;
            }
            _ => return Err(Usage::Invalid(format!("unrecognized arguments: {word}"))),
        }
    }
    Ok(args)
}

/// Reads the saved configuration and parses it alone, as `--key value` for each entry. Nothing
/// from the original command line carries over.
pub fn from_config(path: &Path) -> Result<Args, Usage> {
    let failed = |message: String| Usage::Failed(Error(message));
    let text = std::fs::read_to_string(path).map_err(|error| failed(error.to_string()))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| failed(error.to_string()))?;
    let entries = value
        .as_object()
        .ok_or_else(|| failed("The saved configuration is not an object".into()))?;
    let mut argv = Vec::new();
    for (key, value) in entries {
        let word = match value {
            serde_json::Value::String(text) => text.clone(),
            serde_json::Value::Number(number) if number.is_i64() || number.is_u64() => {
                number.to_string()
            }
            _ => {
                return Err(failed(format!(
                    "The saved configuration has an unusable {key}"
                )));
            }
        };
        argv.extend([OsString::from(format!("--{key}")), OsString::from(word)]);
    }
    parse(&argv)
}
