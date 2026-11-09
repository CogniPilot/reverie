use super::*;
const STAT: &str = "# started\n752.21,msec,task-clock:u,752206441,100.00,,\n";
const REPORT: &str = "# Total Lost Samples: 0\n# Samples: 73  of event 'task-clock:u'\n";
fn nonce() -> JournalId {
    JournalId::parse("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee").unwrap()
}
#[test]
fn actual_software_counter_shape_roundtrips_with_exact_nonce_and_ordinary_uid() {
    let data = PerfCheckData::from_perf(nonce(), 1000, 2, STAT, REPORT).unwrap();
    let read = PerfCheckData::decode(&data.encode().unwrap()).unwrap();
    assert_eq!(read.nonce(), &nonce());
    assert_eq!(read.uid(), 1000);
    assert_eq!(read.wire.samples, 73);
    assert_eq!(read.wire.task_clock_milliseconds, 752.21);
}
#[test]
fn counter_refuses_missing_duplicate_unsupported_or_nonpositive_results() {
    for stat in [
        String::new(),
        STAT.repeat(2),
        STAT.replace("msec", "seconds"),
        STAT.replace("task-clock:u", "cycles"),
        STAT.replace("752.21", "<not counted>"),
        STAT.replace("752.21", "<not supported>"),
        STAT.replace("752.21", "0"),
        STAT.replace("752.21", "-1"),
        STAT.replace("752.21", "NaN"),
        STAT.replace("752.21", "inf"),
    ] {
        assert!(PerfCheckData::from_perf(nonce(), 1000, 2, &stat, REPORT).is_err());
    }
}
#[test]
fn recording_requires_one_positive_selected_event_and_known_zero_loss() {
    for report in [
        String::new(),
        REPORT.repeat(2),
        REPORT.replace("Samples: 73", "Samples: 0"),
        REPORT.replace("Lost Samples: 0", "Lost Samples: 1"),
        REPORT.replace("# Total Lost Samples: 0\n", ""),
        REPORT.replace("task-clock:u", "cycles"),
    ] {
        assert!(PerfCheckData::from_perf(nonce(), 1000, 2, STAT, &report).is_err());
    }
}
#[test]
fn result_refuses_privileged_uid_policy_substitution_and_ambiguous_json() {
    let data = PerfCheckData::from_perf(nonce(), 1000, 2, STAT, REPORT).unwrap();
    let raw = String::from_utf8(data.encode().unwrap()).unwrap();
    for value in [
        raw.replace("\"uid\":1000", "\"uid\":0"),
        raw.replace("task-v2", "task-v1"),
        raw.replace("\"version\":1", "\"version\":1,\"version\":1"),
        raw.replace("\"version\":1", "\"version\":1,\"passed\":true"),
        raw.replace("\"version\":1", "\"version\":1.0"),
    ] {
        assert!(PerfCheckData::decode(value.as_bytes()).is_err());
    }
    assert!(PerfCheckData::from_perf(nonce(), 0, 2, STAT, REPORT).is_err());
}
