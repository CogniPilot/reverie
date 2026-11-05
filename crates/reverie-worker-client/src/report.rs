use crate::{Error, Result, cli::uuid, frame::Connection, json};
use serde_json::{Value, json};
use std::collections::BTreeSet;
const MAX_COUNT: u64 = 2_147_483_647;
const TOOLS: &[&str] = &["shell", "python", "git", "zip", "UNKNOWN_COMMAND"];
pub(crate) fn selected(employees: &[String]) -> Result<()> {
    if employees.len() > 64
        || employees.iter().any(|employee| !uuid(employee))
        || employees.iter().collect::<BTreeSet<_>>().len() != employees.len()
    {
        return Err(Error("TELEMETRY_REPORT_REFUSED"));
    }
    Ok(())
}
fn integer(value: &Value, maximum: u64) -> Result<u64> {
    value
        .as_u64()
        .filter(|number| *number <= maximum)
        .ok_or(Error("TELEMETRY_REPORT_REFUSED"))
}
fn group(value: &Value, maximum: u64) -> Result<(String, String, i64, u64)> {
    let tool = value["tool"]
        .as_str()
        .filter(|tool| TOOLS.contains(tool))
        .ok_or(Error("TELEMETRY_REPORT_REFUSED"))?;
    let code = value["exit"]
        .as_i64()
        .filter(|code| (-255..=255).contains(code) && *code != 0)
        .ok_or(Error("TELEMETRY_REPORT_REFUSED"))?;
    let category = if code == 127 {
        "COMMAND_NOT_FOUND"
    } else if code < 0 {
        "SIGNAL"
    } else {
        "NONZERO"
    };
    json::need(value["category"].as_str() == Some(category))?;
    let count = integer(&value["count"], maximum)?;
    json::need(count > 0)?;
    Ok((tool.into(), category.into(), code, count))
}
fn counts(value: &Value) -> Result<()> {
    let counts = value["counts"]
        .as_array()
        .filter(|rows| rows.len() <= 20)
        .ok_or(Error("TELEMETRY_REPORT_REFUSED"))?;
    let mut seen = BTreeSet::new();
    let mut total = 0;
    for row in counts {
        json::closed(row, &["tool", "category", "exit", "count"])?;
        let (tool, category, code, count) = group(row, 2048)?;
        json::need(seen.insert((tool, category, code)))?;
        total += count;
    }
    json::need(total <= 2048)?;
    for key in ["evicted", "expired", "dropped"] {
        integer(&value[key], MAX_COUNT)?;
    }
    Ok(())
}
fn employee(value: &Value, expected: &str, enabled: bool) -> Result<()> {
    json::closed(
        value,
        &[
            "employee_id",
            "harness",
            "status",
            "counts",
            "truncated",
            "evicted",
            "expired",
            "dropped",
        ],
    )?;
    json::need(
        value["employee_id"].as_str() == Some(expected)
            && value["harness"] == "hands"
            && value["truncated"].is_boolean(),
    )?;
    let status = value["status"]
        .as_str()
        .ok_or(Error("TELEMETRY_REPORT_REFUSED"))?;
    json::need(if enabled {
        ["ready", "no_data", "unavailable"].contains(&status)
    } else {
        status == "disabled"
    })?;
    counts(value)?;
    if status != "ready" {
        json::need(
            value["counts"].as_array().is_some_and(Vec::is_empty)
                && value["truncated"] == false
                && ["evicted", "expired", "dropped"]
                    .iter()
                    .all(|key| value[*key].as_u64() == Some(0)),
        )?;
    }
    Ok(())
}
fn validate(raw: &[u8], expected: &[String]) -> Result<Value> {
    if raw.len() > 262_144 {
        return Err(Error("TELEMETRY_REPORT_REFUSED"));
    }
    selected(expected)?;
    let value = json::decode(raw)?;
    json::closed(
        &value,
        &[
            "v",
            "enabled",
            "provenance",
            "harness_support",
            "employees",
            "top_repeats",
            "truncated",
        ],
    )?;
    json::need(
        value["v"].as_u64() == Some(1)
            && value["enabled"].is_boolean()
            && value["provenance"] == "SELF_REPORTED_RESULT"
            && value["truncated"].is_boolean(),
    )?;
    json::need(
        value["harness_support"]
            == json!({"hands":"self_reported","claude":"unavailable","codex":"unavailable"}),
    )?;
    let enabled = value["enabled"].as_bool().expect("checked boolean");
    let employees = value["employees"]
        .as_array()
        .ok_or(Error("TELEMETRY_REPORT_REFUSED"))?;
    json::need(employees.len() == expected.len())?;
    for (row, expected) in employees.iter().zip(expected) {
        employee(row, expected, enabled)?;
    }
    let top = value["top_repeats"]
        .as_array()
        .filter(|rows| rows.len() <= 20)
        .ok_or(Error("TELEMETRY_REPORT_REFUSED"))?;
    let mut seen = BTreeSet::new();
    for row in top {
        json::closed(
            row,
            &["tool", "category", "exit", "count", "employee_count"],
        )?;
        let (tool, category, code, _) = group(row, 2048 * expected.len() as u64)?;
        json::need(
            seen.insert((tool, category, code))
                && integer(&row["employee_count"], expected.len() as u64)? > 0,
        )?;
    }
    if !enabled {
        json::need(top.is_empty() && value["truncated"] == false)?;
    }
    Ok(value)
}
pub(crate) fn run(connection: &mut Connection, employees: &[String]) -> Result<Vec<u8>> {
    connection.send(
        b'T',
        &serde_json::to_vec(&json!({"v":1,"action":"command-failures","employee_ids":employees}))?,
    )?;
    let frame = connection.receive(262_144)?;
    if frame.kind != b'J' {
        return Err(Error("TELEMETRY_REPORT_UNAVAILABLE"));
    }
    let value =
        validate(&frame.payload, employees).map_err(|_| Error("TELEMETRY_REPORT_REFUSED"))?;
    connection.validate()?;
    Ok(serde_json::to_vec(&value)?)
}

#[cfg(test)]
mod tests {
    use super::{selected, validate};
    use serde_json::{Value, json};
    const EMPLOYEE: &str = "11111111-2222-3333-4444-555555555555";
    fn valid() -> Value {
        json!({"v":1,"enabled":true,"provenance":"SELF_REPORTED_RESULT","harness_support":{"hands":"self_reported","claude":"unavailable","codex":"unavailable"},"employees":[{"employee_id":EMPLOYEE,"harness":"hands","status":"ready","counts":[{"tool":"git","category":"NONZERO","exit":1,"count":2}],"truncated":false,"evicted":0,"expired":0,"dropped":0}],"top_repeats":[{"tool":"git","category":"NONZERO","exit":1,"count":2,"employee_count":1}],"truncated":false})
    }
    fn accepted(value: &Value) -> bool {
        validate(&serde_json::to_vec(value).unwrap(), &[EMPLOYEE.into()]).is_ok()
    }
    #[test]
    fn employee_selection_is_bounded_unique_lowercase_and_ordered() {
        assert!(selected(&[]).is_ok());
        assert!(selected(&["00000000-0000-0000-0000-000000000000".into()]).is_ok());
        assert!(selected(&[EMPLOYEE.into(), EMPLOYEE.into()]).is_err());
        assert!(selected(&["AAAAAAAA-2222-3333-4444-555555555555".into()]).is_err());
        assert!(selected(&vec![EMPLOYEE.into(); 65]).is_err());
    }
    #[test]
    fn report_closed_shape_numeric_category_and_unavailable_invariants() {
        let original = valid();
        assert!(accepted(&original));
        for (path, replacement) in [
            ("/v", json!(true)),
            ("/v", json!(1.0)),
            ("/enabled", json!(1)),
            (
                "/employees/0/employee_id",
                json!("00000000-0000-0000-0000-000000000000"),
            ),
            ("/employees/0/status", json!("disabled")),
            ("/employees/0/truncated", json!(0)),
            ("/employees/0/counts/0/tool", json!("unreviewed")),
            ("/employees/0/counts/0/exit", json!(0)),
            ("/employees/0/counts/0/exit", json!(-256)),
            ("/employees/0/counts/0/exit", json!(127)),
            ("/employees/0/counts/0/count", json!(0)),
            ("/employees/0/counts/0/count", json!(2049)),
            ("/employees/0/evicted", json!(2147483648_u64)),
            ("/employees/0/status", json!("unavailable")),
            ("/top_repeats/0/employee_count", json!(0)),
            ("/top_repeats/0/employee_count", json!(2)),
            ("/top_repeats/0/count", json!(2049)),
            ("/truncated", json!("false")),
        ] {
            let mut value = original.clone();
            *value.pointer_mut(path).unwrap() = replacement;
            assert!(!accepted(&value), "{path}");
        }
        for target in ["counts", "top_repeats"] {
            let mut value = original.clone();
            let rows = if target == "counts" {
                value["employees"][0]["counts"].as_array_mut().unwrap()
            } else {
                value["top_repeats"].as_array_mut().unwrap()
            };
            rows.push(rows[0].clone());
            assert!(!accepted(&value));
        }
        let mut extra = original.clone();
        extra["employees"][0]["private_command"] = "never".into();
        assert!(!accepted(&extra));
        let mut empty = original;
        empty["enabled"] = false.into();
        empty["employees"][0]["status"] = "disabled".into();
        empty["employees"][0]["counts"] = json!([]);
        empty["top_repeats"] = json!([]);
        assert!(accepted(&empty));
        empty["truncated"] = true.into();
        assert!(!accepted(&empty));
    }
}
