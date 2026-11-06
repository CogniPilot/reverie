use reverie_core::{
    capacity::{self, CapacityCounter, CapacityError},
    decimal::UnsignedInteger,
};
use serde::Deserialize;
use serde_json::value::RawValue;
use std::collections::BTreeMap;
#[derive(Deserialize)]
struct Case {
    name: String,
    raw: String,
    answer: Option<bool>,
    error: bool,
}
fn integer(raw: &RawValue) -> Option<UnsignedInteger> {
    let raw = raw.get();
    UnsignedInteger::parse(if raw == "-0" { "0" } else { raw })
}
fn counter(
    fields: &BTreeMap<String, Box<RawValue>>,
    name: &str,
) -> Result<CapacityCounter, CapacityError> {
    CapacityCounter::from_integer(
        &fields
            .get(name)
            .and_then(|raw| integer(raw))
            .ok_or(CapacityError::IntegerFact)?,
    )
}
fn evaluate(case: &Case) -> Result<bool, CapacityError> {
    if case.name == "legacy_headroom_fits" {
        let args: Vec<Box<RawValue>> = serde_json::from_str(&case.raw).unwrap();
        return match (integer(&args[0]), integer(&args[1])) {
            (Some(worker), Some(total)) => capacity::legacy_headroom_fits(&worker, &total),
            _ => Ok(false),
        };
    }
    let fields: BTreeMap<String, Box<RawValue>> = serde_json::from_str(&case.raw).unwrap();
    if case.name == "explicit_host_headroom_fits" {
        return capacity::explicit_host_headroom_fits(
            counter(&fields, "pool_bytes")?,
            counter(&fields, "site_bytes")?,
            counter(&fields, "reserve_bytes")?,
            counter(&fields, "total_bytes")?,
            counter(&fields, "available_bytes")?,
        );
    }
    capacity::pool_headroom_fits(
        counter(&fields, "budget_bytes")?,
        counter(&fields, "committed_bytes")?,
        counter(&fields, "retained_bytes")?,
        counter(&fields, "candidate_bytes")?,
    )
}
#[test]
fn actual_python_capacity_boundaries_float_rounding_and_invalid_facts_match() {
    let cases: Vec<Case> = serde_json::from_str(include_str!(
        "fixtures/reservation-engine/capacity-python.json"
    ))
    .unwrap();
    assert_eq!(cases.len(), 134);
    for case in cases {
        let result = evaluate(&case);
        assert_eq!(result.is_err(), case.error, "{} {}", case.name, case.raw);
        if let Ok(value) = result {
            assert_eq!(Some(value), case.answer, "{} {}", case.name, case.raw);
        }
    }
}
