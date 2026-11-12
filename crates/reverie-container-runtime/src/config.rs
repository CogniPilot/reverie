//! Operator-selected container model settings. No host discovery, builds or downloads.
use reverie_local_model::{Args, args};
use std::ffi::OsString;
use std::path::PathBuf;

pub(crate) type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub(crate) struct Model {
    pub(crate) args: Args,
    pub(crate) key: PathBuf,
    pub(crate) socket: PathBuf,
    pub(crate) port: u16,
    pub(crate) layers: String,
    cache: CacheType,
}

enum CacheType {
    F16,
    Q8,
}

impl CacheType {
    fn from_env() -> Result<Self> {
        match selected("REVERIE_LOCAL_MODEL_CACHE_TYPE")
            .as_deref()
            .unwrap_or("f16")
        {
            "f16" => Ok(Self::F16),
            "q8_0" => Ok(Self::Q8),
            _ => Err("model cache type must be f16 or q8_0".into()),
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Self::F16 => "f16",
            Self::Q8 => "q8_0",
        }
    }
}

fn selected(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn regular_path(value: &str) -> Result<()> {
    if value.contains(['\n', '\r', '\0']) || !std::path::Path::new(value).is_absolute() {
        return Err("model paths must be absolute and contain no control characters".into());
    }
    if !std::fs::metadata(value)?.is_file() {
        return Err("model inputs must be existing regular files".into());
    }
    Ok(())
}

impl Model {
    pub(crate) fn from_env() -> Result<Option<Self>> {
        let Some(model) = selected("REVERIE_LOCAL_MODEL") else {
            return Ok(None);
        };
        let mut words: Vec<OsString> = vec!["--model".into(), model.into()];
        for (variable, flag) in [
            ("REVERIE_LOCAL_MODEL_ALIAS", "--alias"),
            ("REVERIE_LOCAL_MODEL_CONTEXT", "--context"),
            ("REVERIE_LOCAL_MODEL_MMPROJ", "--mmproj"),
            ("REVERIE_LOCAL_MODEL_IMAGE_MAX_TOKENS", "--image-max-tokens"),
            ("REVERIE_LOCAL_MODEL_SAMPLING_PROFILE", "--sampling-profile"),
        ] {
            if let Some(value) = selected(variable) {
                words.extend([flag.into(), value.into()]);
            }
        }
        let parsed =
            args::parse(&words).map_err(|error| format!("model configuration: {error:?}"))?;
        let data = selected("REVERIE_DATA").unwrap_or_else(|| "/instances/default".into());
        let model = Self {
            args: parsed,
            key: selected("REVERIE_LOCAL_MODEL_KEY_FILE").map_or_else(
                || PathBuf::from(&data).join("runtime/model/api-key"),
                PathBuf::from,
            ),
            socket: selected("REVERIE_LOCAL_MODEL_SOCKET").map_or_else(
                || PathBuf::from(data).join("runtime/model/default.sock"),
                PathBuf::from,
            ),
            port: selected("REVERIE_LOCAL_MODEL_PORT")
                .unwrap_or_else(|| "8092".into())
                .parse()?,
            layers: selected("REVERIE_LOCAL_MODEL_GPU_LAYERS").unwrap_or_else(|| "all".into()),
            cache: CacheType::from_env()?,
        };
        model.validate()?;
        Ok(Some(model))
    }

    pub(crate) fn validate(&self) -> Result<()> {
        regular_path(self.args.model.as_deref().ok_or("model is required")?)?;
        if let Some(projector) = &self.args.mmproj {
            regular_path(projector)?;
        }
        let alias = &self.args.alias;
        if alias.is_empty()
            || alias.len() > 100
            || !alias.as_bytes()[0].is_ascii_alphanumeric()
            || !alias
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
        {
            return Err("model alias must be a simple name".into());
        }
        if !(512..=262144).contains(&self.args.context)
            || !(128..=8192).contains(&self.args.image_max_tokens)
            || self.port == 0
            || !self.key.is_absolute()
            || !self.socket.is_absolute()
            || self.socket.as_os_str().len() > 100
            || (self.layers != "all"
                && (self.layers.is_empty()
                    || !self.layers.bytes().all(|byte| byte.is_ascii_digit())))
        {
            return Err("invalid model context, image budget, port, key path or GPU layers".into());
        }
        Ok(())
    }

    pub(crate) fn cache_type(&self) -> &'static str {
        self.cache.as_str()
    }
}
