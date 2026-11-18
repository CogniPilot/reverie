use super::files::Directory;
use reverie_contracts::hands_web;
use serde_json::{Map, Value};

const ALLOWED: &[&str] = &[
    "temperature",
    "reply_max_tokens",
    "model_timeout_s",
    "prompt_cap_chars",
    "token_meter",
    "memory_instance",
    "memory_file",
    "coding",
    "vision",
    "image_tokens_per_image",
    "admin_task",
    "phone_wake",
    "poll_s",
    "search",
    "search_url",
    "web_fetch",
    "search_max_calls",
    "search_results",
    "search_result_chars",
    "search_timeout_s",
    "search_max_bytes",
    "web_log",
    "journal_enabled",
];
const INTEGER_LIMITS: &[(&str, u64, u64)] = &[
    ("reply_max_tokens", 128, 32768),
    ("prompt_cap_chars", 1000, 120000),
    ("image_tokens_per_image", 128, 8192),
];
const NUMBER_LIMITS: &[(&str, f64, f64)] = &[
    ("temperature", 0.0, 2.0),
    ("model_timeout_s", 1.0, 900.0),
    ("poll_s", 1.0, 300.0),
];

pub(super) fn load(directory: &Directory) -> crate::Result<Map<String, Value>> {
    let bytes = directory.read_settings().map_err(
        |_| "Hands runtime settings must be an owned private regular file, at most 64KiB",
    )?;
    let Some(bytes) = bytes else {
        return Ok(Map::new());
    };
    let overrides = serde_json::from_slice(&bytes).map_err(|_| "Invalid Hands runtime settings")?;
    validate(&overrides)?;
    Ok(overrides)
}

fn validate(overrides: &Map<String, Value>) -> crate::Result<()> {
    if overrides.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err("Unsupported Hands runtime setting");
    }
    for key in ["vision", "phone_wake", "journal_enabled"] {
        if overrides.get(key).is_some_and(|item| !item.is_boolean()) {
            return Err("Invalid Hands boolean setting");
        }
    }
    for &(key, low, high) in INTEGER_LIMITS {
        if overrides
            .get(key)
            .is_some_and(|item| item.as_u64().is_none_or(|n| !(low..=high).contains(&n)))
        {
            return Err("Invalid Hands integer limit");
        }
    }
    for &(key, low, high) in NUMBER_LIMITS {
        if overrides
            .get(key)
            .is_some_and(|item| item.as_f64().is_none_or(|n| !(low..=high).contains(&n)))
        {
            return Err("Invalid Hands numeric limit");
        }
    }
    hands_web::validate_settings(overrides)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn launch_settings_keep_identity_and_validate_the_same_limits() {
        let valid = json!({"reply_max_tokens":16384,"model_timeout_s":900,"prompt_cap_chars":120000,"vision":true,"image_tokens_per_image":2048,"search":true,"search_url":"http://[::1]:8080/search","web_fetch":true});
        assert!(validate(valid.as_object().unwrap()).is_ok());
        for invalid in [
            json!({"self_session_id":"other"}),
            json!({"reply_max_tokens":true}),
            json!({"model_timeout_s":901}),
            json!({"phone_wake":1}),
            json!({"poll_s":0}),
            json!({"poll_s":true}),
            json!({"image_tokens_per_image":0}),
            json!({"prompt_cap_chars":120001}),
            json!({"vision":1}),
            json!({"web_fetch":1}),
            json!({"search":true}),
            json!({"search_url":"https://user:password@example.com"}),
            json!({"search_url":"http://example.com:99999"}),
            json!({"search_max_calls":100}),
            json!({"search_timeout_s":0}),
            json!({"search_max_bytes":99999999}),
        ] {
            assert!(validate(invalid.as_object().unwrap()).is_err(), "{invalid}");
        }
    }
}
