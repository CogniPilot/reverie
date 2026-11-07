use super::*;

#[test]
fn config_validation_refuses_like_load_config() {
    for (body, message) in [
        ("bogus = 1\n", "config: unknown keys ['bogus']"),
        (
            "zz = 1\nbogus = 2\n",
            "config: unknown keys ['bogus', 'zz']",
        ),
        (
            "interval_s = 0\n",
            "config: interval_s must be a positive integer",
        ),
        ("gpu = \"maybe\"\n", "config: gpu must be auto or off"),
        (
            "drives = [\"x\"]\n",
            "config: drives must be a table of name = path",
        ),
        (
            "max_prune_join = true\n",
            "config: max_prune_join must be a positive integer",
        ),
    ] {
        assert_eq!(parse_config(body), Err(message.to_owned()), "{body}");
    }
    let parsed =
        parse_config("label = \"rack-1\"\ngpu = \"off\"\n[drives]\nroot = \"/\"\n").unwrap();
    assert_eq!(parsed.label, Out::text("rack-1"));
    assert!(!parsed.gpu_auto);
    assert_eq!(parsed.drives.get("root").map(String::as_str), Some("/"));
    assert_eq!(parsed.max_file_bytes, 64 << 20);
}

#[test]
fn python_number_text_rules() {
    assert_eq!(python_int(" 1_000 "), Some(1000));
    assert_eq!(python_int("-7"), Some(-7));
    for bad in ["", "_1", "1_", "1__0", "1.0", "+"] {
        assert_eq!(python_int(bad), None, "{bad:?}");
    }
    assert_eq!(python_float("1_0.5"), Some(10.5));
    assert_eq!(python_float(" .5 "), Some(0.5));
    assert!(python_float("-Infinity").is_some_and(|value| value == f64::NEG_INFINITY));
    assert!(python_float("nan").is_some_and(f64::is_nan));
    for bad in ["", "e5", "1_e5", "0x1", "1__0"] {
        assert_eq!(python_float(bad), None, "{bad:?}");
    }
}

#[test]
fn bad_readings_are_errors_not_values() {
    assert_eq!(cpu_times("nope\n"), Err("InputError"));
    assert_eq!(cpu_times("cpu  1 2 x 4\n"), Err("ValueError"));
    // Exactly four values: idle has no iowait term.
    assert_eq!(cpu_times("cpu  1 2 3 4\ncpu0 1\n"), Ok(((10, 4), 1)));
    assert_eq!(memory("garbage\n"), Err("InputError"));
    assert_eq!(loadavg("1 2\n"), Err("ValueError"));
    assert_eq!(loadavg("-1 2 3\n"), Err("InputError"));
    assert_eq!(cpu_pct((100.0, 50.0), (100, 50)), None);
    assert_eq!(cpu_pct((0.0, 0.0), (800, 700)), Some(12.5));
}

#[test]
fn nvidia_rows_drop_non_finite_and_untrusted_identities() {
    // A NaN device is dropped, not reported: the reading falls back.
    assert_eq!(nvidia_devices("0, nan, 1, 2\n"), None);
    let uuid = "GPU-ABCDEF01-2345-6789-abcd-ef0123456789";
    let rows =
        format!("0, 10, 1, 2, {uuid}\n1, 20, 1, 2, {uuid}\n2, 30, 1, 2, N/A\n3, 40, 1, 2, junk\n");
    let devices = nvidia_devices(&rows).unwrap();
    let status = devices
        .iter()
        .map(|device| device.identity_status)
        .collect::<Vec<_>>();
    assert_eq!(status, ["duplicate", "duplicate", "unavailable", "invalid"]);
    // A duplicate still counts when its twin is dropped as non-finite.
    let rows = format!("0, 10, 1, 2, {uuid}\n1, nan, 1, 2, {uuid}\n");
    assert_eq!(
        nvidia_devices(&rows).unwrap()[0].identity_status,
        "duplicate"
    );
    let many = (0..65)
        .map(|index| format!("{index}, 5, 1, 2, {uuid}\n"))
        .collect::<String>();
    let devices = nvidia_devices(&many).unwrap();
    assert_eq!(devices.len(), 64);
    assert!(
        devices
            .iter()
            .all(|device| device.identity_status == "incomplete")
    );
    assert_eq!(nvidia_devices("0, 1, 2\n"), None);
}

#[test]
fn splitlines_matches_str_splitlines() {
    assert_eq!(
        splitlines("a\r\nb\rc\u{2028}d\u{85}e\n"),
        ["a", "b", "c", "d", "e"]
    );
    assert_eq!(splitlines("a\n\nb"), ["a", "", "b"]);
    assert!(splitlines("").is_empty());
}

#[test]
fn dry_live_partial_and_failed_runs_are_separate_in_a_rollup() {
    let (samples, _) = records(
        "{\"t\": 100, \"cpu_pct\": 10, \"mem_pct\": 20.5}\n{\"t\": 200, \"cpu_pct\": 30.0}\n",
    );
    let (runs, _) = records(concat!(
        "{\"committed_t\": 150, \"mode\": \"dry\", \"status\": \"ok\", \"would_delete_bytes\": 900, \"deleted_bytes\": 0}\n",
        "{\"committed_t\": 160, \"mode\": \"live\", \"status\": \"partial\", \"would_delete_bytes\": 0, \"deleted_bytes\": 300}\n",
        "{\"committed_t\": 170, \"mode\": \"live\", \"status\": \"failed\", \"deleted_or_would_bytes\": 5}\n",
        "{\"committed_t\": 9999, \"mode\": \"live\", \"status\": \"ok\", \"deleted_bytes\": 1}\n",
    ));
    let samples = samples.iter().collect::<Vec<_>>();
    let record = rollup(&samples, Window::Hour, 0, Some(&runs), true).unwrap();
    let text = dump(&record).unwrap();
    for part in [
        "\"cpu_pct\":{\"avg\":20.0,\"max\":30.0,\"min\":10,\"n\":2}",
        "\"mem_pct\":{\"avg\":20.5,\"max\":20.5,\"min\":20.5,\"n\":1}",
        "\"prune_bytes\":305",
        "\"prune_bytes_by_mode\":{\"dry_would_delete\":900,\"live_deleted\":305}",
        "\"prune_runs_dry\":1",
        "\"prune_runs_failed\":1",
        "\"prune_runs_live\":2",
        "\"prune_runs_partial\":1",
    ] {
        assert!(text.contains(part), "{part} in {text}");
    }
    let unavailable =
        dump(&rollup(&samples, Window::Hour, 0, Some(&runs), false).unwrap()).unwrap();
    assert!(
        unavailable.contains("\"prune_bytes\":null")
            && unavailable.contains("\"prune_unavailable\":true")
    );
    assert_eq!(
        rollup(&samples, Window::Hour, 3600, Some(&runs), true),
        None
    );
}

/// The GPU identity scenarios of tests/test_cleanup_package.py.
mod gpu_identity {
    use super::*;

    const UUID_A: &str = "GPU-01234567-89ab-cdef-0123-456789abcdef";
    const UUID_B: &str = "GPU-fedcba98-7654-3210-fedc-ba9876543210";

    fn read(output: &str) -> (Out, Vec<GpuDevice>) {
        let devices = nvidia_devices(output).unwrap();
        let (percent, _) = Gpu::Devices {
            source: "nvidia-smi",
            devices: devices.clone(),
        }
        .out();
        (percent, devices)
    }

    #[test]
    fn uuid_tracks_same_devices_across_index_reordering_without_changing_aggregate() {
        let first = read(&format!(
            "0, 40, 100, 8000, {UUID_A}\n1, 60, 200, 16000, {UUID_B}\n"
        ));
        let second = read(&format!(
            "0, 60, 200, 16000, {UUID_B}\n1, 40, 100, 8000, {UUID_A}\n"
        ));
        assert_eq!(
            (first.0.clone(), second.0.clone()),
            (Out::Float(50.0), Out::Float(50.0))
        );
        let readings = |devices: &[GpuDevice]| {
            devices
                .iter()
                .map(|device| {
                    (
                        device.uuid.clone(),
                        device.util_pct,
                        device.memory.unwrap().1,
                        device.identity_status,
                    )
                })
                .collect::<Vec<_>>()
        };
        let expected = [
            (Some(UUID_A.to_owned()), 40.0, 8000.0, "available"),
            (Some(UUID_B.to_owned()), 60.0, 16000.0, "available"),
        ];
        for (_, devices) in [&first, &second] {
            let found = readings(devices);
            assert_eq!(found.len(), 2);
            for row in &expected {
                assert!(found.iter().any(|seen| seen.0 == row.0
                    && seen.1 == row.1
                    && seen.2 == row.2
                    && seen.3 == row.3));
            }
        }
        let order = |devices: &[GpuDevice]| {
            devices
                .iter()
                .map(|device| device.uuid.clone())
                .collect::<Vec<_>>()
        };
        let mut reversed = order(&second.1);
        reversed.reverse();
        assert_eq!(order(&first.1), reversed);
    }

    #[test]
    fn bad_or_duplicate_identity_preserves_metrics_but_never_false_device_attribution() {
        let upper = format!("GPU-{}", UUID_A[4..].to_uppercase());
        let (percent, devices) = read(&format!(
            "0, 10, 1, 2, {UUID_A}\n1, 20, 1, 2, {upper}\n2, 30, 1, 2, GPU-not-a-uuid\n3, 40, 1, 2, N/A\n4, 50, 1, 2\n"
        ));
        assert_eq!(percent, Out::Float(30.0));
        assert!(devices.iter().all(|device| device.uuid.is_none()));
        let status = devices
            .iter()
            .map(|device| device.identity_status)
            .collect::<Vec<_>>();
        assert_eq!(
            status,
            [
                "duplicate",
                "duplicate",
                "invalid",
                "unavailable",
                "unavailable"
            ]
        );
    }

    #[test]
    fn capped_listing_marks_identities_incomplete_instead_of_missing_late_duplicates() {
        let mut rows = (0..64)
            .map(|n| format!("{n}, 25, 1, 2, GPU-{n:08x}-0000-0000-0000-000000000000"))
            .collect::<Vec<_>>();
        rows.push(rows[0].clone());
        let (percent, devices) = read(&rows.join("\n"));
        assert_eq!((percent, devices.len()), (Out::Float(25.0), 64));
        assert!(
            devices
                .iter()
                .all(|device| device.uuid.is_none() && device.identity_status == "incomplete")
        );
    }

    #[test]
    fn invalid_metrics_are_still_excluded_and_cannot_hide_duplicate_identity() {
        let (percent, devices) = read(&format!(
            "0, 40, 1, 2, {UUID_A}\n1, nan, 1, 2, {UUID_A}\n2, 101, 1, 2, {UUID_B}\n3, 20, -1, 2, {UUID_B}\n4, 60, 1, 2, {UUID_B}\n"
        ));
        assert_eq!(percent, Out::Float(50.0));
        assert_eq!(
            devices
                .iter()
                .map(|device| device.index)
                .collect::<Vec<_>>(),
            [0, 4]
        );
        assert!(
            devices
                .iter()
                .all(|device| device.uuid.is_none() && device.identity_status == "duplicate")
        );
    }
}
