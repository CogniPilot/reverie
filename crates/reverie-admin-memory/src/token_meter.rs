//! Admission against the tokenizer attached to a Hands model.
mod budget;
#[cfg(test)]
mod tests;

use budget::Budget;
pub(super) use budget::Stats;
use reverie_host::embeddings::model_api::{Client, Failure, Route};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{env, io, time::Duration};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Settings {
    base_url: String,
    context_ceiling: u64,
    #[serde(default = "default_margin")]
    margin: u64,
    #[serde(default = "default_timeout")]
    timeout_s: f64,
    #[serde(default = "default_limit")]
    max_bytes: usize,
    key_env: Option<KeyName>,
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

#[derive(Deserialize)]
#[serde(try_from = "String")]
pub(super) struct KeyName(String);

impl TryFrom<String> for KeyName {
    type Error = &'static str;

    fn try_from(name: String) -> Result<Self, Self::Error> {
        if key_name_valid(&name) {
            Ok(Self(name))
        } else {
            Err("invalid model API key variable")
        }
    }
}

pub(super) fn credential(name: Option<&KeyName>) -> Result<Option<String>, Failure> {
    name.map(|name| {
        env::var(&name.0)
            .ok()
            .filter(|value| !value.is_empty())
            .ok_or(Failure::Invalid)
    })
    .transpose()
}

impl Settings {
    pub(super) fn configure(self) -> Result<Meter, Failure> {
        let timeout = Duration::try_from_secs_f64(self.timeout_s).map_err(|_| Failure::Invalid)?;
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

pub(super) struct Meter {
    client: Client,
    budget: Budget,
    key_env: Option<KeyName>,
}

impl Meter {
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

    pub(super) async fn measure(&self, payload: &Value) -> Result<Stats, Failure> {
        let key = credential(self.key_env.as_ref())?;
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
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    #[serde(rename = "action")]
    _action: Action,
    settings: Settings,
}

pub(super) fn run(expected_parent: i32) -> io::Result<()> {
    crate::bind_worker(expected_parent)?;
    let input = io::BufReader::new(io::stdin().lock());
    let result = serde_json::from_reader::<_, Request>(input)
        .map_err(|_| Failure::Invalid)
        .and_then(|request| request.settings.configure());
    let status = if result.is_ok() { "ok" } else { "invalid" };
    crate::write_reply(&json!({"status": status}), crate::REQUEST_BOUND)
}
