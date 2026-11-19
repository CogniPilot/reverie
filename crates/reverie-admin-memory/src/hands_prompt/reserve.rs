//! Reserve prompt capacity for transcript growth and request-time context.

use super::{
    presentation::chars,
    request::{SUMMARY_CAP, schema_chars},
};
use crate::{hands_settings::truthy, hands_turn::WebPolicy, turn_tool::TURN_RESERVE};
use serde::Deserialize;
use serde_json::{Map, Value, json, value::RawValue};
use std::io;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    cap: usize,
    web: WebPolicy,
    journal: bool,
    task: Option<Task>,
    summary: bool,
    managed: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Task {
    rule: String,
    tools: Box<RawValue>,
}

impl Request {
    pub(crate) fn calculate(self) -> io::Result<Value> {
        let required = tool_reserve(self.web, self.journal)
            .saturating_add(self.task.map_or(Ok(0), task_reserve)?);
        let summary = if self.summary {
            SUMMARY_CAP.min(self.cap / 10)
        } else {
            0
        };
        let managed = if self.managed {
            20_000.min(self.cap / 3)
        } else {
            0
        };
        let preferred = required.saturating_add(summary).saturating_add(managed);
        Ok(json!({"required": required, "preferred": preferred}))
    }
}

fn task_reserve(task: Task) -> io::Result<usize> {
    Ok(chars(&task.rule) + schema_chars(Some(&task.tools))?)
}

fn tool_reserve(web: WebPolicy, journal: bool) -> usize {
    web.reserve()
        .saturating_add(if journal { TURN_RESERVE } else { 0 })
}

pub(crate) fn check_startup_budget(settings: &Map<String, Value>) -> Result<(), &'static str> {
    const BAD_CAP: &str = "config: prompt caps must be nonnegative integers";
    let cap = |key: &str| settings[key].as_u64().map(u128::from).ok_or(BAD_CAP);
    let mut minimum = cap("identity_cap_chars")?
        + cap("memory_cap_chars")?
        + 2 * cap("message_cap_chars")?
        + 2000;
    if truthy(&settings["memory_instance"]) {
        minimum += cap("recall_cap_chars")? + 128;
    }
    let web = WebPolicy::from_settings(settings);
    minimum += tool_reserve(web, truthy(&settings["journal_enabled"])) as u128;
    if cap("prompt_cap_chars")? < minimum {
        return Err(
            "config: prompt_cap_chars too small for the identity, memory and message caps and search rounds",
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Request;
    use serde_json::json;

    #[test]
    fn preferred_reserve_includes_optional_context_and_keeps_required_total() {
        let request: Request = serde_json::from_value(json!({
            "cap": 60000,
            "web": {"search": false, "fetch": false, "max_calls": 2, "result_chars": 4000},
            "journal": true, "task": {"rule": "é", "tools": []},
            "summary": true, "managed": true,
        }))
        .unwrap();
        assert_eq!(
            request.calculate().unwrap(),
            json!({"required": 18_903, "preferred": 41_903})
        );
    }
}
