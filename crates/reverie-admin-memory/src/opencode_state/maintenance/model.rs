use crate::model_completion::{clean_reply, request};
use reverie_core::{
    PythonText,
    memory_configuration::{IntegerSetting, TextSetting},
};
use reverie_host::{embeddings::model_api::Route, memory_configuration::MemoryConfiguration};
use serde_json::{Value, json};
use std::time::Duration;

pub(super) fn complete(
    config: &MemoryConfiguration,
    system: &str,
    user: &str,
    tokens: u64,
    temperature: f64,
    chars: i64,
    vacation: bool,
) -> Option<String> {
    let seconds =
        u64::try_from(super::integer(config, IntegerSetting::RequestTimeout).ok()?).ok()?;
    let seconds = if vacation { seconds.min(120) } else { seconds };
    let base = config
        .settings()
        .text(TextSetting::ApiBase)
        .as_text_ref()
        .scalar_text()?;
    let selected = config
        .settings()
        .text(TextSetting::Model)
        .as_text_ref()
        .scalar_text()?;
    let body = json!({
        "model":selected, "messages":[{"role":"system","content":system},{"role":"user","content":user}],
        "max_tokens":tokens, "temperature":temperature,
        "chat_template_kwargs":{"enable_thinking":false},
    });
    let body = serde_json::to_vec(&body).ok()?;
    let raw = request(
        &base,
        Route::Completions,
        Some(body),
        Duration::from_secs(seconds),
        None,
    )
    .ok()?;
    let value: Value = serde_json::from_slice(&raw).ok()?;
    let text = value["choices"][0]["message"]["content"].as_str()?;
    let points = clean_reply(&PythonText::from_scalar_text(text), chars);
    points.into_iter().map(char::from_u32).collect()
}
