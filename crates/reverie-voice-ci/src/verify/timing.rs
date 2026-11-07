use crate::{Result, need};
use serde_json::Value;

pub(super) fn check(event: &Value) -> Result<()> {
    let timing = &event["timing"];
    need(
        event["status"] == "completed" && timing["status"] == "completed",
        "Synthesis did not complete normally",
    )?;
    let keys = [
        "lockAttemptNs",
        "acquiredNs",
        "inferenceStartNs",
        "inferenceEndNs",
        "finishedNs",
    ];
    let values: Vec<u64> = keys
        .iter()
        .map(|key| {
            timing[key]
                .as_u64()
                .ok_or("Missing synthesis queue/inference timing")
        })
        .collect::<std::result::Result<_, _>>()?;
    need(
        values.windows(2).all(|pair| pair[0] <= pair[1]) && values[3] > values[2],
        "Invalid synthesis queue/inference timing",
    )?;
    let request = event["requestNs"]
        .as_u64()
        .ok_or("Missing synth request timing")?;
    let response = event["responseNs"]
        .as_u64()
        .ok_or("Missing synth response timing")?;
    need(
        response > request && request <= values[0] && values[4] <= response,
        "Synthesis timing is outside its request",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn actual_inference_times_must_be_complete_integral_ordered_and_in_request() {
        let event = json!({"status":"completed","requestNs":1,"responseNs":7,
            "timing":{"status":"completed","lockAttemptNs":2,"acquiredNs":3,
            "inferenceStartNs":4,"inferenceEndNs":5,"finishedNs":6}});
        check(&event).unwrap();
        for (key, value) in [
            ("inferenceEndNs", json!(3)),
            ("acquiredNs", json!(true)),
            ("inferenceStartNs", json!(-1)),
            ("status", json!("busy")),
            ("finishedNs", json!(8)),
            ("inferenceEndNs", json!(4)),
            ("acquiredNs", Value::Null),
        ] {
            let mut changed = event.clone();
            changed["timing"][key] = value;
            assert!(check(&changed).is_err(), "{key}");
        }
    }
}
