//! Admission against the tokenizer attached to a Hands model.
mod budget;
#[cfg(test)]
mod tests;

use budget::{Budget, Stats};
use reverie_host::embeddings::tokenizer::{Client, Failure, Route};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{env, io, time::Duration};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    base_url: String,
    context_ceiling: u64,
    #[serde(default = "default_margin")]
    margin: u64,
    #[serde(default = "default_timeout")]
    timeout_s: f64,
    #[serde(default = "default_limit")]
    max_bytes: usize,
    key_env: Option<String>,
    #[serde(default)]
    image_tokens_per_image: u64,
}

const fn default_margin() -> u64 {
    512
}
const fn default_timeout() -> f64 {
    3.0
}
const fn default_limit() -> usize {
    1_048_576
}

fn key_name_valid(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte == b'_' || byte.is_ascii_uppercase())
        && bytes.all(|byte| byte == b'_' || byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

impl Settings {
    fn configure(self) -> Result<Meter, Failure> {
        let timeout = Duration::try_from_secs_f64(self.timeout_s).map_err(|_| Failure::Invalid)?;
        if self
            .key_env
            .as_deref()
            .is_some_and(|name| !key_name_valid(name))
        {
            return Err(Failure::Invalid);
        }
        Ok(Meter {
            client: Client::new(self.base_url, timeout, self.max_bytes)?,
            budget: Budget::new(
                self.context_ceiling,
                self.margin,
                self.image_tokens_per_image,
            )?,
            key_env: self.key_env,
        })
    }
}

struct Meter {
    client: Client,
    budget: Budget,
    key_env: Option<String>,
}

impl Meter {
    fn key(&self) -> Result<Option<String>, Failure> {
        self.key_env
            .as_deref()
            .map(|name| {
                env::var(name)
                    .ok()
                    .filter(|value| !value.is_empty())
                    .ok_or(Failure::Invalid)
            })
            .transpose()
    }

    async fn request<T: DeserializeOwned>(
        &self,
        route: Route,
        data: Option<&Value>,
        key: Option<&str>,
    ) -> Result<T, Failure> {
        let data = data
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|_| Failure::Invalid)?;
        let response = self.client.request(route, data, key).await?;
        serde_json::from_slice(&response).map_err(|_| Failure::Invalid)
    }

    async fn measure(&self, payload: &Value) -> Result<Stats, Failure> {
        let key = self.key()?;
        let properties = self
            .request(Route::Properties, None, key.as_deref())
            .await?;
        let context = self.budget.context(properties)?;
        let completion = budget::completion(payload)?;
        let Template { prompt } = self
            .request(Route::ApplyTemplate, Some(payload), key.as_deref())
            .await?;
        budget::require_tools(payload, &prompt)?;
        let input = json!({"content": prompt, "add_special": true, "parse_special": true, "with_pieces": false});
        let Tokens { tokens } = self
            .request(Route::Tokenize, Some(&input), key.as_deref())
            .await?;
        let count = budget::token_count(&tokens)?;
        self.budget.stats(payload, context, count, completion)
    }
}

#[derive(Deserialize)]
struct Template {
    prompt: String,
}

#[derive(Deserialize)]
struct Tokens {
    tokens: Vec<serde_json::Number>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Action {
    Validate,
    Measure,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    action: Action,
    settings: Settings,
    payload: Option<Value>,
}

impl Request {
    fn execute(self) -> Result<Option<Stats>, Failure> {
        let meter = self.settings.configure()?;
        match (self.action, self.payload) {
            (Action::Validate, None) => Ok(None),
            (Action::Measure, Some(payload)) => {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|_| Failure::Invalid)?;
                runtime.block_on(meter.measure(&payload)).map(Some)
            }
            _ => Err(Failure::Invalid),
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum Reply {
    Ok { stats: Option<Stats> },
    Timeout,
    Http { code: u16 },
    Invalid,
}

impl From<Result<Option<Stats>, Failure>> for Reply {
    fn from(result: Result<Option<Stats>, Failure>) -> Self {
        match result {
            Ok(stats) => Self::Ok { stats },
            Err(Failure::Timeout) => Self::Timeout,
            Err(Failure::Http(code)) => Self::Http { code },
            Err(Failure::Invalid) => Self::Invalid,
        }
    }
}

pub(super) fn run(expected_parent: i32) -> io::Result<()> {
    crate::bind_worker(expected_parent)?;
    let input = io::BufReader::new(io::stdin().lock());
    let result = serde_json::from_reader::<_, Request>(input)
        .map_err(|_| Failure::Invalid)
        .and_then(Request::execute);
    crate::write_reply(&Reply::from(result), crate::REQUEST_BOUND)
}
