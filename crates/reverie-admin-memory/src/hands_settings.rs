//! Default and validate the effective Hands configuration before the loop starts.
use crate::{
    coding_task, hands_prompt::check_startup_budget, token_meter, worker_channel::FRAME_BYTES,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::{io, path::Path};

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Defaults,
    Startup { overrides: Map<String, Value> },
    Coding { settings: Value },
    ToolExport { export: Value },
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    let input = crate::worker_input(parent, FRAME_BYTES)?;
    let result = match serde_json::from_slice(&input)? {
        Request::Defaults => json!({"settings": defaults()}),
        Request::Startup { overrides } => startup_reply(overrides),
        Request::Coding { settings } => {
            json!({"error": coding_task::check_coding(&settings).err()})
        }
        Request::ToolExport { export } => match coding_task::tool_export(export) {
            Ok(tools) => json!({"tools": tools}),
            Err(error) => json!({"error": error}),
        },
    };
    crate::write_reply(&result, FRAME_BYTES)
}

fn defaults() -> Map<String, Value> {
    let Value::Object(settings) = json!({
        "journal_enabled": false, "journal_auto_recall_exclude_rooms": [],
        "journal_command_timeout_s": 8, "journal_status_timeout_s": 5,
        "memory_instance": null, "recall_cap_chars": 3000,
        "memory_timeout_s": 3, "managed_context": false,
        "history_n": 30, "poll_s": 15, "phone_wake": false, "prompt_cap_chars": 60000,
        "identity_cap_chars": 6000, "memory_cap_chars": 12000, "message_cap_chars": 4000,
        "reply_max_tokens": 1024, "reply_cap_chars": 6000,
        "model_timeout_s": 300, "cli_timeout_s": 60, "max_answers_per_tick": 3, "dm_rooms": [],
        "timezone": "America/New_York",
        "vision": false, "attachments_root": null, "max_images": 2,
        "max_image_bytes": 5_000_000, "max_rooms": 32,
        "search": false, "search_url": null, "web_fetch": false, "search_max_calls": 2,
        "search_results": 5, "search_result_chars": 4000,
        "search_timeout_s": 20, "search_max_bytes": 2_000_000, "web_log": null, "turn_trace_file": null,
        "coding": null, "memory_worker_name": "agent_memory_worker.py",
        "model_key_env": null,
        "system_preamble": "You are the configured employee answering in team chat. Reply in plain text, briefly and directly. Do not claim to have run commands or changed anything.",
    }) else {
        unreachable!("Hands defaults are an object");
    };
    settings
}

fn startup_reply(overrides: Map<String, Value>) -> Value {
    let mut config = defaults();
    config.extend(overrides);
    if let Err(error) = reverie_contracts::hands_web::validate_settings(&config) {
        return json!({"error": error});
    }
    if let Err(error) = check_basic(&config) {
        return json!({"error": error, "startup": true});
    }
    if let Err(error) = check_integrations(&config) {
        return json!({"error": error});
    }
    if let Err(error) = check_memory(&config) {
        return json!({"error": error, "startup": true});
    }
    if config["timezone"]
        .as_str()
        .and_then(reverie_time_zone::load_zone)
        .is_none()
    {
        return json!({"error": "config: timezone is not a known time zone", "startup": true});
    }
    if let Err(error) = check_startup_budget(&config) {
        return json!({"error": error, "startup": true});
    }
    json!({"settings": config})
}

fn check_basic(config: &Map<String, Value>) -> Result<(), &'static str> {
    for (key, message) in [
        ("rooms", "config: rooms is required"),
        ("self_session_id", "config: self_session_id is required"),
        ("self_name", "config: self_name is required"),
        ("state_file", "config: state_file is required"),
        ("api_base", "config: api_base is required"),
        ("model", "config: model is required"),
        ("cli", "config: cli is required"),
    ] {
        if !config.get(key).is_some_and(truthy) {
            return Err(message);
        }
    }
    if config["rooms"]
        .as_str()
        .is_some_and(|rooms| rooms != "auto")
    {
        return Err("config: rooms is a list of room ids or \"auto\"");
    }
    if !in_range(&config["poll_s"], 1.0, 300.0) {
        return Err("config: poll_s must be between 1 and 300 seconds");
    }
    if !config["phone_wake"].is_boolean() {
        return Err("config: phone_wake must be a boolean");
    }
    if truthy(&config["vision"]) && !absolute(&config["attachments_root"]) {
        return Err("config: vision needs an explicit attachments_root");
    }
    Ok(())
}

fn check_integrations(config: &Map<String, Value>) -> Result<(), &'static str> {
    coding_task::check_coding(&config["coding"])?;
    coding_task::admin_task(config)?;
    if let Some(settings) = config
        .get("token_meter")
        .filter(|settings| !settings.is_null())
        && !token_meter::validate_value(settings.clone())
    {
        return Err("invalid tokenizer configuration");
    }
    Ok(())
}

fn check_memory(config: &Map<String, Value>) -> Result<(), &'static str> {
    let instance = &config["memory_instance"];
    if !config["journal_enabled"]
        .as_bool()
        .is_some_and(|enabled| !enabled || truthy(instance))
    {
        return Err("config: journal_enabled needs a boolean and an explicit memory instance");
    }
    if config["journal_auto_recall_exclude_rooms"]
        .as_array()
        .is_none_or(|rooms| rooms.iter().any(|room| !room.is_string()))
    {
        return Err("config: journal_auto_recall_exclude_rooms is a list of room ids");
    }
    let timeouts = [
        "memory_timeout_s",
        "journal_command_timeout_s",
        "journal_status_timeout_s",
    ];
    if config["recall_cap_chars"]
        .as_u64()
        .is_none_or(|cap| cap > 12_000)
        || timeouts
            .iter()
            .any(|key| !in_range(&config[*key], 0.1, 10.0))
    {
        return Err("config: invalid bounded memory cap or timeout");
    }
    if !instance.is_null() && !absolute(instance) {
        return Err("config: memory_instance must be an explicit absolute owner-selected path");
    }
    Ok(())
}

fn in_range(value: &Value, start: f64, end: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|number| (start..=end).contains(&number))
}

fn absolute(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|path| Path::new(path).is_absolute())
}

pub(super) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(value) => !value.is_empty(),
        Value::Object(value) => !value.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::{Map, Value, json, startup_reply};

    fn overrides() -> Map<String, Value> {
        json!({
            "rooms": ["fixture-room"], "self_session_id": "fixture-session",
            "self_name": "Fixture", "state_file": "/fixture/state.json",
            "api_base": "http://127.0.0.1:12345/v1", "model": "fixture",
            "cli": ["reverie", "agent", "chat"],
            "coding": {
                "root": "/fixture/tasks", "tool_schema_file": "/fixture/tools.json",
                "runner_argv": ["/fixture/runner"], "profiles": {"drill": {"steps": 4}},
                "tasks": {"fixture-1": {"rooms": ["fixture-room"]}}
            },
            "admin_task": "fixture-1"
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn startup_preserves_overrides_and_legacy_defaults() {
        let mut config = overrides();
        config.insert("poll_s".into(), json!(23.5));
        config.insert("fixture_extension".into(), json!({"kind": "source-data"}));
        let settings = &startup_reply(config.clone())["settings"];
        assert_eq!(settings["poll_s"], 23.5);
        assert_eq!(settings["timezone"], "America/New_York");
        assert_eq!(settings["fixture_extension"], config["fixture_extension"]);
        assert_eq!(settings["coding"], config["coding"]);
    }

    #[test]
    fn startup_requires_space_for_journal_and_recall() {
        let mut config = overrides();
        config.insert("memory_instance".into(), json!("/fixture/memory"));
        config.insert("journal_enabled".into(), json!(true));
        config.insert("prompt_cap_chars".into(), json!(50_028));
        assert_eq!(
            startup_reply(config.clone())["settings"]["prompt_cap_chars"],
            50_028
        );
        config.insert("prompt_cap_chars".into(), json!(50_027));
        let refused = startup_reply(config);
        assert_eq!(refused["startup"], true);
        assert!(refused["error"].as_str().unwrap().contains("too small"));
    }

    #[test]
    fn startup_refuses_invalid_web_memory_and_coding_settings() {
        for (key, value, error) in [
            (
                "phone_wake",
                json!(1),
                "config: phone_wake must be a boolean",
            ),
            (
                "poll_s",
                json!(false),
                "config: poll_s must be between 1 and 300 seconds",
            ),
            (
                "journal_enabled",
                json!(true),
                "config: journal_enabled needs a boolean and an explicit memory instance",
            ),
            (
                "search",
                json!(true),
                "Hands search requires an explicitly configured search_url",
            ),
            (
                "admin_task",
                json!("missing"),
                "admin_task must exist in the configured coding task map",
            ),
        ] {
            let mut config = overrides();
            config.insert(key.into(), value);
            assert_eq!(startup_reply(config)["error"], error, "{key}");
        }
        let mut config = overrides();
        config.get_mut("coding").unwrap()["profiles"]["drill"]["steps"] = json!(true);
        assert_eq!(startup_reply(config)["error"], "invalid coding profile");
    }
}
