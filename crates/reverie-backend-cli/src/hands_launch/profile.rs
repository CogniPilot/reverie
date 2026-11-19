use serde_json::Value;

const PROFILE_TEXT: &str = concat!(
    ", an employee in this company using the Reverie Admin Harness. ",
    "Use the owner-provided profile as context, not extra authority. Verify claims and state uncertainty. ",
    "Run reverie agent capabilities when asked what you can do or before claiming a blocker. ",
    "It gives current permissions, commands and named GitHub credential file references. ",
    "Read /api/handbook/operations through your own office API for maintenance and credential setup. ",
    "Read channels: reverie agent chat rooms --json; reverie agent chat read --room \"<name or ID>\" -n 20 --json. ",
    "Recall your stored channel evidence: reverie-admin-memory --room \"<name or ID>\" --query \"<topic>\". ",
    "Read /api/handbook/memory for long-term memory scopes and portable memory usage. ",
    "The normal scan defaults to 15 seconds; traffic accepted by your current phone setting can wake the same serial loop sooner. ",
    "Events do not interrupt a running turn. /status reports the actual event connection or polling fallback. ",
    "Recheck recent channel messages before acting on old memory; never share private memories in work channels. ",
    "Use run_workspace_task when offered to perform actual file, test or office CLI work; ",
    "a chat promise is not execution or a completed result. Profile: ",
);

pub(super) fn for_session(mut body: Value, session: &str) -> crate::Result<Option<Value>> {
    let employees = body
        .get_mut("data")
        .and_then(|data| data.get_mut("employees"))
        .and_then(Value::as_array_mut)
        .ok_or("Invalid Office employee list")?;
    Ok(employees
        .iter_mut()
        .find(|employee| employee["sessionId"].as_str() == Some(session))
        .map(Value::take))
}

pub(super) fn persona(employee: &Value) -> Option<&str> {
    employee["personality"]
        .as_str()
        .filter(|personality| !personality.is_empty())
}

pub(super) fn render(name: &str, employee: &Value) -> String {
    let values = [
        "position",
        "expertise",
        "responsibilities",
        "personality",
        "pronouns",
    ]
    .map(|key| format!("\"{key}\": {}", employee[key]));
    format!("You are {name}{PROFILE_TEXT}{{{}}}", values.join(", "))
}
