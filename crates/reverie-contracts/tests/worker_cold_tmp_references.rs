use reverie_contracts::worker_cold_tmp::*;
use serde_json::Value;

#[test]
fn proc_credentials_keep_byte_framing_arbitrary_nonmatches_and_invalid_uid_refusal() {
    assert!(reference_credentials(b"Name: \xff\r\nUid: 1000 1000 1000 1000\r\n", 1000).unwrap());
    assert!(reference_credentials(b"Uid: 0 1000 0 0\n", 1000).unwrap());
    let huge = format!("Uid: {0} {0} {0} {0}\n", "9".repeat(100));
    assert!(!reference_credentials(huge.as_bytes(), 1000).unwrap());
    for raw in [
        b"Uid: 1000 1000 1000\n".as_slice(),
        b"Uid: +1000 0 0 0\n",
        b"Uid: 1000 1000 1000 1000\nUid: 1000 1000 1000 1000\n",
    ] {
        assert!(reference_credentials(raw, 1000).is_err());
    }
    let invalid = format!("Uid: {} 0 0 0\n", "0".repeat(4301));
    assert!(reference_credentials(invalid.as_bytes(), 1000).is_err());
}
#[test]
fn identity_validates_original_isdigit_without_restricting_start_text_to_decimal() {
    for start in ["123", "²", "١٢٣"] {
        let raw = format!("42 (name with ) inside) S {} {start}", "0 ".repeat(18));
        let identity = ReferenceProcessIdentity::parse(&raw).unwrap();
        assert_eq!(identity.start(), start);
        assert!(!identity.terminal());
    }
    let zombie = format!("42 (name) Z {} 777", "0 ".repeat(18));
    assert!(ReferenceProcessIdentity::parse(&zombie).unwrap().terminal());
    for raw in [
        "missing delimiter".into(),
        format!("42 (x) S {} x", "0 ".repeat(18)),
    ] {
        assert!(ReferenceProcessIdentity::parse(&raw).is_err());
    }
}
#[test]
fn fd_headers_require_both_identities_preserve_arbitrary_precision_and_stop_early() {
    let mut header = ReferenceFdHeader::default();
    assert!(header.push(b"ignored: garbage\n").unwrap().is_none());
    assert!(header.push(b"ino: 42\n").unwrap().is_none());
    assert_eq!(
        header.push(b"mnt_id: 00012\n").unwrap().unwrap().as_str(),
        "12"
    );
    assert!(header.push(b"mnt_id: 12\n").is_err());
    let mut header = ReferenceFdHeader::default();
    assert!(header.push(b"mnt_id: +12\n").is_err());
    assert!(header.push(&vec![b'x'; 4097]).is_err());
    assert!(header.push(b"mnt_id: 12\n").unwrap().is_none());
}
#[test]
fn unix_and_map_rows_preserve_maxsplit_tails_crlf_and_surrogateescape() {
    let raw = b"header\r\n0: 1 0 0 1 01 12 /tmp/with spaces \xff\r\n0: 1 0 0 1 01 13\n";
    let rows = ReferenceUnixRow::parse(raw).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].inode().as_str(), "12");
    let path = rows[0].path().unwrap().codepoints();
    assert_eq!(path.last(), Some(&0xdcff));
    assert!(rows[1].path().is_none());
    let rows = ReferenceMapRow::parse(
        b"0-1 rw-p 0 +0x_08:00 1_2 /tmp/with spaces \xff\r\n0-1 r--p 0 -0:0 -1\n",
    )
    .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].device(), (8, 0));
    assert_eq!(rows[0].inode().unwrap().as_str(), "12");
    assert_eq!(rows[0].path().unwrap().codepoints().last(), Some(&0xdcff));
    assert!(!rows[1].zero_inode());
    assert!(rows[1].inode().is_none());
    for raw in [
        b"bad\n".as_slice(),
        b"0-1 rw-p 0 100000000:00 12\n",
        b"0-1 rw-p 0 1__:00 12\n",
    ] {
        assert!(ReferenceMapRow::parse(raw).is_err());
    }
}
#[test]
fn complete_report_counts_all_observations_but_caps_only_examples_and_disclaims_absence() {
    let mut report = ReferenceReport::default();
    report.note_process().unwrap();
    for _ in 0..64 {
        report
            .record(42, ReferenceKind::Known(KnownReference::NamespaceSocket))
            .unwrap();
        report
            .record(42, ReferenceKind::Unknown(UnknownReference::Coordinates))
            .unwrap();
    }
    report.note_maps(256 << 20).unwrap();
    assert!(report.note_maps(1).is_err());
    report.note_unix(64 << 20).unwrap();
    assert!(report.note_unix(1).is_err());
    assert_eq!((report.known_count(), report.unknown_count()), (64, 64));
    let raw: Value = serde_json::from_slice(&report.encode()).unwrap();
    assert_eq!(raw["knownReferences"].as_array().unwrap().len(), 32);
    assert_eq!(raw["unknownReferences"].as_array().unwrap().len(), 32);
    assert_eq!(raw["knownReferences"][0]["observerPid"], 42);
    assert!(raw["knownReferences"][0].get("pid").is_none());
    assert_eq!(raw["allInitiallyEnumeratedProcessesVisited"], true);
    assert_eq!(raw["absenceOfReferencesProven"], false);
    assert_eq!(raw["treeWalkPerformed"], false);
}
