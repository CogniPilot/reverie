use reverie_contracts::kernel_accounting::{HostAccounting, swap_total};
use serde::Deserialize;

#[derive(Deserialize)]
struct Accounting {
    name: String,
    raw: String,
    total: Option<String>,
    available: Option<String>,
    error: Option<String>,
}
#[derive(Deserialize)]
struct Swap {
    name: String,
    raw: String,
    error: Option<String>,
}
#[derive(Deserialize)]
struct Corpus {
    accounting: Vec<Accounting>,
    swap: Vec<Swap>,
}
fn corpus() -> Corpus {
    serde_json::from_str(include_str!(
        "fixtures/reservation-engine/accounting-python.json"
    ))
    .unwrap()
}
#[test]
fn actual_python_host_accounting_reports_its_own_error() {
    let cases = corpus().accounting;
    assert_eq!(cases.len(), 10);
    for case in cases {
        match HostAccounting::parse(&case.raw) {
            Ok(facts) => {
                assert_eq!(case.error, None, "{}", case.name);
                assert_eq!(Some(facts.total().as_str()), case.total.as_deref());
                assert_eq!(Some(facts.available().as_str()), case.available.as_deref());
            }
            Err(error) => assert_eq!(Some(error.code()), case.error.as_deref(), "{}", case.name),
        }
    }
}
#[test]
fn actual_python_swap_distinguishes_malformed_capacity_and_conversion() {
    let cases = corpus().swap;
    assert_eq!(cases.len(), 10);
    for case in cases {
        let error = swap_total(&case.raw).err().map(|error| error.code());
        assert_eq!(error, case.error.as_deref(), "{}", case.name);
    }
}
