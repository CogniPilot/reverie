use reverie_contracts::{worker_cold_tmp::*, worker_config};

#[test]
fn retained_names_keep_raw_key_identity_and_strict_ascii_registration_grammar() {
    let name = RetainedLeaseName::parse("0001-0002.003.json").unwrap();
    assert_eq!(name.key(), "0001-0002");
    assert_eq!(name.kind(), RetainedLeaseKind::Holder);
    for (raw, kind) in [
        ("0-0.lock", RetainedLeaseKind::Lock),
        ("1-2.path.json", RetainedLeaseKind::Path),
        ("1-2.reserve.json", RetainedLeaseKind::Reservation),
    ] {
        assert_eq!(RetainedLeaseName::parse(raw).unwrap().kind(), kind);
    }
    for bad in [
        "barrier.lock",
        "1-2..json",
        "1-2.other.json",
        "+1-2.lock",
        "١-2.lock",
        "1--2.lock",
        "1-2.3.json.extra",
    ] {
        assert!(RetainedLeaseName::parse(bad).is_err(), "{bad}");
    }
}

#[test]
fn retained_registered_paths_use_strict_utf8_bytes_and_original_path_spelling() {
    let record = |path: &str| {
        RetainedLeaseRecord::decode(
            &serde_json::to_vec(&serde_json::json!({"version":1,"path":path})).unwrap(),
        )
        .unwrap()
    };
    for valid in [
        "/".to_owned(),
        "//host/path".to_owned(),
        format!("/{}", "a".repeat(4095)),
        format!("/{}a", "é".repeat(2047)),
    ] {
        assert_eq!(
            record(&valid).registered_path().unwrap().codepoints(),
            valid.chars().map(u32::from).collect::<Vec<_>>()
        );
    }
    for bad in [
        "relative".to_owned(),
        "/tmp/".to_owned(),
        "/tmp/./a".to_owned(),
        "/tmp//a".to_owned(),
        "/tmp/../a".to_owned(),
        "/tmp\0a".to_owned(),
        format!("/{}", "a".repeat(4096)),
        format!("/{}aa", "é".repeat(2047)),
    ] {
        assert!(record(&bad).registered_path().is_err(), "{bad:?}");
    }
    for raw in [
        br#"{"version":1,"path":"/tmp/\udcff"}"#.as_slice(),
        br#"{"version":1,"path":null}"#,
        br#"{"version":1}"#,
    ] {
        assert!(
            RetainedLeaseRecord::decode(raw)
                .unwrap()
                .registered_path()
                .is_err()
        );
    }
    assert!(RetainedLeaseRecord::decode(br#"{"version":true,"path":"/tmp"}"#).is_err());
    assert!(
        RetainedLeaseRecord::decode(br#"{"version":1,"path":"/tmp","path":"/other"}"#).is_err()
    );
    assert!(
        RetainedLeaseRecord::decode(
            br#"{"version":1,"path":"/tmp","extension":{"duplicate":0,"duplicate":1}}"#
        )
        .is_err()
    );
}

fn ids() -> ColdInventoryIds {
    ColdInventoryIds::decode(format!("{}\n{}", "a".repeat(64), "b".repeat(64)).as_bytes()).unwrap()
}

#[test]
fn clear_records_use_original_sorted_spaced_ascii_python_wire() {
    use reverie_core::ids::{NativeOperationId, ProfileSessionId};
    let attempt = NativeOperationId::parse("11111111-2222-4333-8444-555555555555").unwrap();
    let session = ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap();
    let pending = clear_pending_record(&attempt, "identity", &session, (1, 2));
    assert_eq!(
        std::str::from_utf8(&pending).unwrap(),
        r#"{"attemptId": "11111111-2222-4333-8444-555555555555", "identity": "identity", "sessionId": "00000000-0000-0000-0000-000000000000", "state": "ATTEMPT", "tmpDevice": 1, "tmpInode": 2, "version": 1}"#
    );
    let complete = clear_complete_record(&attempt, "identity", &session, (1, 2), 4096);
    let value: serde_json::Value = serde_json::from_slice(&complete).unwrap();
    assert_eq!(value["state"], "COMPLETE");
    assert_eq!(value["removedEntries"], 4096);
}

#[test]
fn unchanged_python_lease_timestamps_keep_integer_and_overflow_boundaries() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/cold-tmp/lease-reservation-python.json"
    ))
    .unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 52);
    for case in cases {
        let result = clear_reservation(
            Some(case["raw"].as_str().unwrap().as_bytes()),
            case["now"].as_f64().unwrap(),
        );
        if case["error"].is_null() {
            let expected = match case["state"].as_u64().unwrap() {
                0 => ColdLeaseState::Free,
                1 => ColdLeaseState::InUse,
                2 => ColdLeaseState::Unknown,
                _ => panic!("original lease state"),
            };
            assert_eq!(result.unwrap(), expected, "{}", case["label"]);
        } else {
            assert!(result.is_err(), "{}", case["label"]);
        }
    }
    assert_eq!(
        clear_reservation(None, 1000.0).unwrap(),
        ColdLeaseState::Free
    );
    assert_eq!(
        clear_reservation(Some(b"malformed"), 1000.0).unwrap(),
        ColdLeaseState::Unknown
    );
}

#[test]
fn lease_clear_and_retirement_readers_preserve_distinct_source_purposes() {
    let loose = br#"{"version":true,"created_utc":999,"until_utc":1001}"#;
    assert_eq!(
        clear_reservation(Some(loose), 1000.0).unwrap(),
        ColdLeaseState::InUse
    );
    assert!(retained_reservation(loose, 1000.0).is_err());
    let duplicate = br#"{"version":2,"version":1,"created_utc":999,"until_utc":1001}"#;
    assert_eq!(
        clear_reservation(Some(duplicate), 1000.0).unwrap(),
        ColdLeaseState::InUse
    );
    assert!(retained_reservation(duplicate, 1000.0).is_err());
    let bytes = "{\"version\":1,\"path\":\"/owned\"}"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    assert_eq!(
        retained_record_path(&bytes)
            .unwrap()
            .unwrap()
            .scalar_text()
            .unwrap(),
        "/owned"
    );
    assert!(clear_path_metadata(Some(&bytes)).is_err());
    assert!(clear_path_metadata(None).is_ok());
    assert!(clear_path_metadata(Some(br#"{"version":true,"path":"\ud800"}"#)).is_ok());
    for raw in [b"null".as_slice(), b"[]", b"true", b"1"] {
        assert!(clear_holder_metadata(raw).is_ok());
        assert!(retained_record_path(raw).is_err());
    }
}

#[test]
fn unchanged_python_projection_preserves_numeric_and_nested_identity_rules() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/cold-tmp/projection-python.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 32);
    for case in cases {
        let decode = |key: &str| {
            let raw = case[key].as_str().unwrap();
            let listed = case[format!("{key}Ids")].as_str().unwrap();
            ColdInventory::decode(
                raw.as_bytes(),
                &ColdInventoryIds::decode(listed.as_bytes()).unwrap(),
            )
            .unwrap()
        };
        assert_eq!(
            decode("left").same_projection(&decode("right")).unwrap(),
            case["equal"].as_bool().unwrap(),
            "{}",
            case["label"]
        );
    }
}

#[test]
fn census_requires_complete_unique_lowercase_ids_and_python_whitespace() {
    let listed = ids();
    let reverse = ColdInventoryIds::decode(
        format!("\u{85}{}\u{1c}{}\u{3000}", "b".repeat(64), "a".repeat(64)).as_bytes(),
    )
    .unwrap();
    assert!(listed.same_set(&reverse));
    for raw in [
        "A".repeat(64),
        "0".repeat(63),
        format!("{0}\n{0}", "a".repeat(64)),
        (0..513)
            .map(|n| format!("{n:064x}"))
            .collect::<Vec<_>>()
            .join("\n"),
    ] {
        assert!(matches!(
            ColdInventoryIds::decode(raw.as_bytes()),
            Err(ColdDataError::Inventory)
        ));
    }
    assert!(ColdInventoryIds::decode("0".repeat(64).as_bytes()).is_ok());
    for raw in [b"null".as_slice(), b"[]", b"[{}]"] {
        assert!(ColdInventory::decode(raw, &listed).is_err());
    }
}

#[test]
fn state_refuses_bool_float_and_missing_pid_without_narrowing_integer_range() {
    let listed = ColdInventoryIds::decode("a".repeat(64).as_bytes()).unwrap();
    let row = |pid: &str| {
        format!(
            r#"[{{"Id":"{}","State":{{"Running":false,"Paused":false,"Restarting":false,"Pid":{pid}}},"Mounts":[]}}]"#,
            "a".repeat(64)
        )
    };
    for pid in ["true", "false", "0.0", "null", "\"0\""] {
        let inventory = ColdInventory::decode(row(pid).as_bytes(), &listed).unwrap();
        assert!(matches!(
            inventory.rows()[0].state(),
            Err(ColdDataError::State)
        ));
    }
    for (pid, active) in [
        ("0".to_owned(), false),
        ("-0".to_owned(), false),
        ("-1".to_owned(), true),
        ("9".repeat(4300), true),
    ] {
        let inventory = ColdInventory::decode(row(&pid).as_bytes(), &listed).unwrap();
        assert_eq!(inventory.rows()[0].state().unwrap().active(), active);
    }
    assert!(ColdInventory::decode(row(&"9".repeat(4301)).as_bytes(), &listed).is_err());
}

#[test]
fn original_config_strategy_and_lease_paths_are_not_effective_overrides() {
    for raw in [b"{}".as_slice(), br#"{"coldTemporaryCleanup":null}"#] {
        assert!(
            ColdConfiguration::capture(&worker_config::decode(raw).unwrap())
                .unwrap()
                .is_none()
        );
    }
    let config = worker_config::decode(br#"{"coldTemporaryCleanup":{"version":1,"enabled":true,"hostLeaseDirectories":["/owned/leases"],"strategy":"retain-and-replace"},"mounts":[{"source":"/owned/src","destination":"/guest"}]}"#).unwrap();
    let captured = ColdConfiguration::capture(&config).unwrap().unwrap();
    assert_eq!(captured.strategy(), ColdStrategy::RetainAndReplace);
    assert_eq!(
        captured.host_lease_directories()[0].scalar_text().unwrap(),
        "/owned/leases"
    );
    let mounts = captured.mounts().unwrap();
    assert_eq!(
        mounts[0].source().unwrap().scalar_text().unwrap(),
        "/owned/src"
    );
    assert_eq!(
        mounts[0].destination().unwrap().scalar_text().unwrap(),
        "/guest"
    );
    assert_eq!(captured.digest().len(), 64);
}
