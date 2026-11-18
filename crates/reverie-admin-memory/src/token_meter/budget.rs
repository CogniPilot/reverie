use reverie_host::embeddings::model_api::Failure;
use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};

#[derive(Deserialize)]
pub(super) struct Properties {
    default_generation_settings: GenerationSettings,
    total_slots: u64,
}

#[derive(Deserialize)]
struct GenerationSettings {
    n_ctx: u64,
}

pub(super) struct Budget {
    ceiling: u64,
    margin: u64,
    image_tokens_per_image: u64,
}

#[derive(Debug, Serialize)]
pub(crate) struct Stats {
    pub(super) prompt_tokens: usize,
    pub(super) context_tokens: u64,
    pub(super) output_tokens: u64,
    pub(super) margin: u64,
    pub(super) slots: u8,
    pub(super) image_tokens: u128,
    pub(crate) admitted: bool,
}

impl Budget {
    pub(super) fn new(
        ceiling: u64,
        margin: u64,
        image_tokens_per_image: u64,
    ) -> Result<Self, Failure> {
        if ceiling == 0 || image_tokens_per_image > 8192 {
            return Err(Failure::Invalid);
        }
        Ok(Self {
            ceiling,
            margin,
            image_tokens_per_image,
        })
    }

    pub(super) fn context(&self, properties: Properties) -> Result<u64, Failure> {
        let available = properties.default_generation_settings.n_ctx;
        if available == 0 || properties.total_slots != 1 {
            return Err(Failure::Invalid);
        }
        Ok(available.min(self.ceiling))
    }

    pub(super) fn stats(
        &self,
        payload: &Value,
        context: u64,
        count: usize,
        completion: u64,
    ) -> Result<Stats, Failure> {
        let images = image_count(payload)?;
        if images != 0 && self.image_tokens_per_image == 0 {
            return Err(Failure::Invalid);
        }
        let image_tokens = images * u128::from(self.image_tokens_per_image);
        let used = count as u128 + image_tokens + u128::from(completion) + u128::from(self.margin);
        Ok(Stats {
            prompt_tokens: count,
            context_tokens: context,
            output_tokens: completion,
            margin: self.margin,
            slots: 1,
            image_tokens,
            admitted: used <= u128::from(context),
        })
    }
}

pub(super) fn completion(payload: &Value) -> Result<u64, Failure> {
    payload
        .get("max_tokens")
        .and_then(Value::as_u64)
        .filter(|&count| count > 0)
        .ok_or(Failure::Invalid)
}

fn optional_list<'a>(payload: &'a Value, field: &str) -> Result<&'a [Value], Failure> {
    match payload.get(field) {
        Some(value) => value.as_array().map(Vec::as_slice).ok_or(Failure::Invalid),
        None => Ok(&[]),
    }
}

pub(super) fn require_tools(payload: &Value, prompt: &str) -> Result<(), Failure> {
    for tool in optional_list(payload, "tools")? {
        let name = tool
            .pointer("/function/name")
            .and_then(Value::as_str)
            .ok_or(Failure::Invalid)?;
        if !prompt.contains(name) {
            return Err(Failure::Invalid);
        }
    }
    Ok(())
}

pub(super) fn token_count(tokens: &[Number]) -> Result<usize, Failure> {
    if tokens.iter().all(|token| token.is_i64() || token.is_u64()) {
        Ok(tokens.len())
    } else {
        Err(Failure::Invalid)
    }
}

fn image_count(payload: &Value) -> Result<u128, Failure> {
    optional_list(payload, "messages")?
        .iter()
        .try_fold(0, |total, message| {
            let message = message.as_object().ok_or(Failure::Invalid)?;
            let parts = message
                .get("content")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            Ok(total + count_parts(parts)?)
        })
}

fn count_parts(parts: &[Value]) -> Result<u128, Failure> {
    parts.iter().try_fold(0, |count, part| {
        let part = part.as_object().ok_or(Failure::Invalid)?;
        Ok(count + u128::from(part.get("type").and_then(Value::as_str) == Some("image_url")))
    })
}
