//! Only an exact final typed report may appear in the task journal.
use serde_json::Value;

const INTEGERS: &[&str] = &[
    "wall_ms",
    "peak_rss_bytes",
    "rss_samples",
    "max_members",
    "disk_samples",
    "workspace_bytes",
    "workspace_entries",
    "min_free_bytes_seen",
];
const INTERVALS: &[&str] = &["rss_interval_s", "disk_interval_s"];

pub(super) fn report(text: &str) -> Option<Value> {
    if text.is_empty() || text.len() > 4096 {
        return None;
    }
    let lines = text
        .strip_suffix("\r\n")
        .or_else(|| text.strip_suffix(line_break))
        .unwrap_or(text);
    let tail = lines.rsplit(line_break).next()?;
    let mut envelope: serde_json::Map<String, Value> = serde_json::from_str(tail).ok()?;
    if envelope.len() != 1 {
        return None;
    }
    let report = envelope.remove("sandbox_runner")?;
    let fields = report.as_object()?;
    if fields
        .get("rc")
        .and_then(Value::as_u64)
        .is_none_or(|value| value > 255)
        || fields.get("mode").and_then(Value::as_str) != Some("task")
        || !matches!(
            fields.get("reason").and_then(Value::as_str),
            Some("done" | "timeout" | "refused" | "watch" | "rss" | "free" | "workspace")
        )
        || !fields.iter().all(|(key, value)| valid_metric(key, value))
    {
        return None;
    }
    Some(report)
}

fn valid_metric(key: &str, value: &Value) -> bool {
    if matches!(key, "rc" | "mode" | "reason") || key == "min_free_bytes_seen" && value.is_null() {
        return true;
    }
    if INTEGERS.contains(&key) {
        return value
            .as_u64()
            .is_some_and(|number| i64::try_from(number).is_ok());
    }
    INTERVALS.contains(&key)
        && value
            .as_f64()
            .is_some_and(|interval| interval > 0.0 && interval <= 86_400.0)
}

fn line_break(ch: char) -> bool {
    matches!(
        ch,
        '\n' | '\r' | '\u{b}' | '\u{c}' | '\u{1c}'..='\u{1e}' | '\u{85}' | '\u{2028}' | '\u{2029}'
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(record: &Value) -> String {
        json!({"sandbox_runner": record}).to_string()
    }

    #[test]
    fn uses_only_the_last_complete_typed_line() {
        let expected = json!({"rc": 0, "mode": "task", "reason": "done", "wall_ms": 10,
            "peak_rss_bytes": 1000, "rss_interval_s": 0.1, "rss_samples": 1, "disk_interval_s": 0.1,
            "disk_samples": 1, "max_members": 1, "workspace_bytes": 1, "workspace_entries": 1,
            "min_free_bytes_seen": null});
        for separator in ["\n", "\r\n", "\u{2028}"] {
            let raw = format!(
                "private diagnostic{separator}{}{separator}",
                line(&expected)
            );
            assert_eq!(report(&raw), Some(expected.clone()));
        }
        let compact = json!({"rc": 2, "mode": "task", "reason": "refused"});
        assert_eq!(report(&line(&compact)), Some(compact));
    }

    #[test]
    fn rejects_unreviewed_fields_and_non_numeric_metrics() {
        let original = json!({"rc": 0, "mode": "task", "reason": "done"});
        for (key, value) in [
            ("detail", json!("private")),
            ("rc", json!(true)),
            ("mode", json!("verify")),
            ("reason", json!("private")),
            ("wall_ms", json!(-1)),
            ("peak_rss_bytes", json!("private")),
            ("rss_interval_s", json!(null)),
            ("disk_interval_s", json!(true)),
            ("max_members", json!(u64::MAX)),
        ] {
            let mut record = original.clone();
            record[key] = value;
            assert!(report(&line(&record)).is_none(), "{key}");
        }
    }

    #[test]
    fn rejects_missing_oversized_malformed_or_nonfinal_reports() {
        let valid = line(&json!({"rc": 0, "mode": "task", "reason": "done"}));
        for bad in [
            "".into(),
            "[]".into(),
            "x".repeat(4097),
            format!("{valid}\nother"),
            format!("{valid}\n\n"),
            line(&json!({})),
            "not-json".into(),
        ] {
            assert!(report(&bad).is_none());
        }
    }
}
