use super::wire::{ARGUMENT_CHARS, FRAME_CHARS, Limits, permitted_tools};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::path::Path;

type Result<T> = std::result::Result<T, &'static str>;

pub(super) fn task_name(name: &str) -> bool {
    matches!(name.as_bytes().first(), Some(b'a'..=b'z' | b'0'..=b'9'))
        && name.len() <= 64
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

pub(crate) fn admin_task(config: &Map<String, Value>) -> Result<()> {
    let Some(task) = config.get("admin_task").filter(|task| !task.is_null()) else {
        return Ok(());
    };
    let name = task
        .as_str()
        .filter(|name| task_name(name))
        .ok_or("admin_task must name an explicitly configured coding task")?;
    config
        .get("coding")
        .and_then(|coding| coding.get("tasks"))
        .and_then(|tasks| tasks.get(name))
        .filter(|task| task.is_object())
        .ok_or("admin_task must exist in the configured coding task map")?;
    Ok(())
}

pub(crate) fn check_coding(settings: &Value) -> Result<()> {
    if settings.is_null() {
        return Ok(());
    }
    let settings = settings
        .as_object()
        .ok_or("coding must be an explicit configuration object")?;
    for (key, error) in [
        ("root", "coding needs an explicit root"),
        (
            "tool_schema_file",
            "coding needs an explicit tool_schema_file",
        ),
    ] {
        if settings
            .get(key)
            .and_then(Value::as_str)
            .is_none_or(|path| !Path::new(path).is_absolute())
        {
            return Err(error);
        }
    }
    boolean(
        settings,
        "failure_telemetry",
        "invalid failure telemetry flag",
    )?;
    let argv = settings
        .get("runner_argv")
        .and_then(Value::as_array)
        .filter(|argv| {
            argv.first()
                .and_then(Value::as_str)
                .is_some_and(|binary| Path::new(binary).is_absolute())
        })
        .ok_or("coding needs fixed runner argv")?;
    if !strings(argv) {
        return Err("coding needs fixed runner argv");
    }
    check_tasks(settings)?;
    if settings
        .get("web_search")
        .is_some_and(|value| value != &Value::Bool(false))
    {
        return Err("proxied coding web search adapter is not connected yet");
    }
    if let Some(meter) = settings.get("token_meter").filter(|meter| !meter.is_null())
        && !crate::token_meter::validate_value(meter.clone())
    {
        return Err("invalid token meter configuration");
    }
    Ok(())
}

fn check_tasks(settings: &Map<String, Value>) -> Result<()> {
    let profiles = settings
        .get("profiles")
        .map(|profiles| {
            profiles
                .as_object()
                .filter(|profiles| !profiles.is_empty())
                .ok_or("coding needs named profiles")
        })
        .transpose()?;
    if let Some(profiles) = profiles {
        for profile in profiles.values() {
            check_profile(profile)?;
        }
    }
    let tasks = settings
        .get("tasks")
        .and_then(Value::as_object)
        .filter(|tasks| tasks.len() <= 64)
        .ok_or("invalid coding task map")?;
    for (name, task) in tasks {
        let task = task
            .as_object()
            .filter(|_| task_name(name))
            .ok_or("invalid coding task")?;
        check_task(task, profiles)?;
    }
    Ok(())
}

fn check_profile(profile: &Value) -> Result<()> {
    let profile = profile.as_object().ok_or("invalid coding profile")?;
    let Value::Object(mut limits) =
        serde_json::to_value(Limits::default()).map_err(|_| "invalid coding profile")?
    else {
        return Err("invalid coding profile");
    };
    limits.extend(profile.clone());
    serde_json::from_value::<Limits>(Value::Object(limits))
        .map_err(|_| "invalid coding profile")?
        .validate()
        .map_err(|_| "invalid coding profile")
}

fn check_task(task: &Map<String, Value>, profiles: Option<&Map<String, Value>>) -> Result<()> {
    let profile = task
        .get("profile")
        .map_or(Some("drill"), Value::as_str)
        .ok_or("invalid coding task")?;
    if !profiles.map_or(profile == "drill", |profiles| {
        profiles.contains_key(profile)
    }) {
        return Err("invalid coding task");
    }
    for key in ["rooms", "delegate_sessions"] {
        if task
            .get(key)
            .is_some_and(|scope| scope.as_array().is_none_or(|scope| !strings(scope)))
        {
            return Err("invalid coding task scope");
        }
    }
    boolean(task, "enabled", "invalid task enabled flag")?;
    boolean(task, "office_access", "invalid task office access flag")
}

fn strings(items: &[Value]) -> bool {
    items
        .iter()
        .all(|item| item.as_str().is_some_and(|text| !text.is_empty()))
}

fn boolean(settings: &Map<String, Value>, key: &str, error: &'static str) -> Result<()> {
    if settings.get(key).is_some_and(|value| !value.is_boolean()) {
        Err(error)
    } else {
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Export {
    version: u32,
    args_cap: usize,
    result_cap: usize,
    tools: Vec<Value>,
}

pub(crate) fn tool_export(value: Value) -> Result<Vec<Value>> {
    let export: Export = serde_json::from_value(value).map_err(|_| "incompatible tool export")?;
    if export.version != 1 || export.args_cap != ARGUMENT_CHARS || export.result_cap != FRAME_CHARS
    {
        return Err("incompatible tool export");
    }
    permitted_tools(&export.tools).map_err(|_| "invalid tool schema")?;
    if export
        .tools
        .iter()
        .any(|schema| schema["function"]["parameters"]["type"].as_str() != Some("object"))
    {
        return Err("invalid tool schema");
    }
    Ok(export.tools)
}
