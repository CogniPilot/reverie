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
