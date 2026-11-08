use super::*;
use serde_json::Value as Json;

fn fixture() -> Json {
    serde_json::from_str(include_str!(
        "../../tests/fixtures/lease-records-python.json"
    ))
    .unwrap()
}
fn state(name: &str) -> ReservationState {
    match name {
        "free" => ReservationState::Free,
        "inUse" => ReservationState::InUse,
        "unknown" => ReservationState::Unknown,
        other => panic!("fixture state {other}"),
    }
}
fn path(fixture: &Json) -> Vec<u32> {
    fixture["pathCodepoints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|point| u32::try_from(point.as_u64().unwrap()).unwrap())
        .collect()
}
fn ascii(value: &str) -> Vec<u32> {
    value.chars().map(u32::from).collect()
}
fn record(fixture: &Json, name: &str) -> Vec<u8> {
    fixture["records"][name]
        .as_str()
        .unwrap()
        .as_bytes()
        .to_vec()
}

#[test]
fn reservation_states_match_the_python_oracle_except_recorded_corrections() {
    let fixture = fixture();
    let now = fixture["now"].as_f64().unwrap();
    let cases = fixture["reservationStates"].as_array().unwrap();
    assert!(cases.len() >= 30);
    for case in cases {
        let text = case["text"].as_str().unwrap();
        assert_eq!(
            reservation_file_state(Some(text.as_bytes()), now),
            state(case["native"].as_str().unwrap()),
            "{case}"
        );
    }
    let corrected = cases
        .iter()
        .filter(|case| case["native"] != case["python"])
        .count();
    assert_eq!(
        corrected, 2,
        "only the recorded null and i128 corrections differ"
    );
    assert_eq!(reservation_file_state(None, now), ReservationState::Free);
}

#[test]
fn undecodable_reservation_bytes_are_unknown() {
    for raw in [
        &b"\xff\xfe"[..],
        b"{\"version\": 1, \"created_utc\": \"\xc3\"",
    ] {
        assert_eq!(
            reservation_file_state(Some(raw), 1.0),
            ReservationState::Unknown
        );
    }
}

#[test]
fn durations_match_the_python_oracle_except_unicode_digits() {
    for case in fixture()["durations"].as_array().unwrap() {
        let expected = case["native"]
            .as_u64()
            .map(|value| u32::try_from(value).unwrap());
        assert_eq!(
            reservation_seconds(case["text"].as_str().unwrap()),
            expected,
            "{case}"
        );
    }
}

#[test]
fn record_bytes_are_python_json_dumps() {
    let fixture = fixture();
    let now = fixture["now"].as_f64().unwrap();
    let path = path(&fixture);
    assert_eq!(
        path_record_bytes(&path, now),
        record(&fixture, "pathRecord")
    );
    assert_eq!(
        reservation_bytes(&path, now, 86400, &ascii("agent"), None),
        record(&fixture, "reservation")
    );
    assert_eq!(
        reservation_bytes(&path, now, 5400, &[], Some(&ascii("c-1"))),
        record(&fixture, "reservationCompute")
    );
    // Python writes compute_lease_id only when it is truthy.
    assert_eq!(
        reservation_bytes(&path, now, 5400, &[], Some(&[])),
        reservation_bytes(&path, now, 5400, &[], None)
    );
    let argv0 = ascii("fixed-public-gpu-job");
    let holder = HolderRecord {
        path: &path,
        pid: 4242,
        start: Some(123_456_789),
        argv0: &argv0,
        utc: now,
        session: 4200,
    };
    assert_eq!(holder_record_bytes(&holder), record(&fixture, "holder"));
    let bare = HolderRecord {
        path: &path,
        pid: 1,
        start: None,
        argv0: &[],
        utc: 1.0,
        session: 1,
    };
    assert_eq!(
        holder_record_bytes(&bare),
        record(&fixture, "holderNoStart")
    );
}

#[test]
fn retirement_records_are_strict_objects_with_integer_version() {
    let fixture = fixture();
    let reserve = record(&fixture, "reservation");
    let parsed = LeaseRecord::parse(&reserve).expect("written reservation");
    assert_eq!(parsed.path(), Some(path(&fixture).as_slice()));
    assert_eq!(
        parsed.reservation_state(fixture["now"].as_f64().unwrap()),
        ReservationState::InUse
    );
    assert_eq!(
        parsed.number_bytes("until_utc").unwrap(),
        b"1794111226.576123".to_vec()
    );
    for refused in [
        &b"null"[..],
        b"[]",
        b"{\"version\": 1.0}",
        b"{\"version\": true}",
        b"{\"version\": 2}",
        b"{}",
        b"{\"version\": 1, \"path\": \"/a\", \"path\": \"/b\"}",
        b"{\"version\": 1",
    ] {
        assert!(LeaseRecord::parse(refused).is_err(), "{refused:?}");
    }
    let no_path = LeaseRecord::parse(b"{\"version\": 1, \"path\": 7}").unwrap();
    assert_eq!(no_path.path(), None);
}

#[test]
fn path_holder_and_renew_readers_follow_python_equality() {
    let path = ascii("/w");
    assert_eq!(
        path_record(&path_record_bytes(&path, 1.5)),
        PathRecord::Path(path.clone())
    );
    for (raw, expected) in [
        (&b"{\"version\": 1.0, \"path\": \"/w\"}"[..], true),
        (b"{\"version\": true, \"path\": \"/w\"}", true),
        (
            b"{\"version\": 1, \"path\": \"/x\", \"path\": \"/w\"}",
            true,
        ),
        (b"{\"version\": 2, \"path\": \"/w\"}", false),
        (b"{\"version\": 1, \"path\": 1}", false),
        (b"[1]", false),
        (b"", false),
    ] {
        assert_eq!(
            path_record(raw) == PathRecord::Path(path.clone()),
            expected,
            "{raw:?}"
        );
    }
    assert!(holder_record_parses(b"[]"));
    assert!(holder_record_parses(b"null"));
    assert!(!holder_record_parses(b"{"));
    assert_eq!(renewable_path(b"{\"path\": \"/w\"}"), Some(path));
    for refused in [&b"{}"[..], b"[\"/w\"]", b"null", b"{\"path\": 1}", b"x"] {
        assert_eq!(renewable_path(refused), None, "{refused:?}");
    }
    assert_eq!(
        LeaseRecord::parse(b"{\"version\": 1, \"a\": 1, \"a\": 2}").err(),
        Some(LeaseRecordError::Duplicate)
    );
    assert_eq!(
        LeaseRecord::parse(b"{").err(),
        Some(LeaseRecordError::Invalid)
    );
    assert_eq!(
        LeaseRecord::parse(b"[]").err(),
        Some(LeaseRecordError::Malformed)
    );
}
