use super::scan::{Kind, file_window};
use super::*;

fn points(text: &str) -> Vec<u32> {
    text.chars().map(u32::from).collect()
}

#[test]
fn canonical_paths_follow_pathlib_normal_form() {
    for (path, expected) in [
        ("/home/agent/obs", true),
        ("/", true),
        ("//share", true),
        ("///a", false),
        ("/a/", false),
        ("/a/./b", false),
        ("/a/../b", false),
        ("relative", false),
        ("/a\u{7f}", false),
        ("/a\nb", false),
    ] {
        assert_eq!(canonical_path(&points(path)), expected, "{path:?}");
    }
}

#[test]
fn file_windows_are_utc_filename_intervals() {
    let day = |name| match file_window(name) {
        Some(Ok(window)) => Some(window),
        _ => None,
    };
    assert_eq!(
        day("samples-2026-11-07.jsonl"),
        Some((Kind::Raw, 1_794_009_600, 1_794_096_000))
    );
    assert_eq!(
        day("rollup-hour-2026-12.jsonl"),
        Some((Kind::Hour, 1_796_083_200, 1_798_761_600))
    );
    assert_eq!(
        day("rollup-day-2024.jsonl"),
        Some((Kind::Day, 1_704_067_200, 1_735_689_600))
    );
    assert!(file_window("samples-2026-1-07.jsonl").is_none());
    assert!(file_window("notes.jsonl").is_none());
    // Python's FILES matches, then datetime raises ValueError: the query refuses.
    for impossible in [
        "samples-2026-02-30.jsonl",
        "rollup-hour-2026-13.jsonl",
        "rollup-day-0000.jsonl",
    ] {
        assert!(
            matches!(file_window(impossible), Some(Err(_))),
            "{impossible}"
        );
    }
}

#[test]
fn final_intervals_past_datetime_max_refuse() {
    // Python cannot construct the end of these periods (OverflowError or
    // ValueError); the native reader refuses rather than extend the calendar.
    for last in [
        "samples-9999-12-31.jsonl",
        "rollup-hour-9999-12.jsonl",
        "rollup-day-9999.jsonl",
    ] {
        assert!(matches!(file_window(last), Some(Err(_))), "{last}");
    }
    assert_eq!(
        file_window("samples-9999-12-30.jsonl").map(Result::ok),
        Some(Some((Kind::Raw, 253_402_128_000, 253_402_214_400)))
    );
}

#[test]
fn configuration_rules_match_collector_user() {
    let config = br#"{"version": 1, "mode": "user-observations", "stateDirectory": "/home/agent/obs/state", "intervalSeconds": 60, "retentionDays": 30, "rollupRetentionDays": 365, "drives": {"root": "/"}, "gpuExecutable": null}"#;
    let parsed = parse_observation_config(config).unwrap();
    assert_eq!(
        (
            parsed.interval_seconds,
            parsed.retention_days,
            parsed.rollup_retention_days
        ),
        (60, 30, 365)
    );
    assert_eq!(parsed.drives, vec![(points("root"), points("/"))]);
    let text = String::from_utf8(config.to_vec()).unwrap();
    for broken in [
        text.replace("\"version\": 1", "\"version\": true"),
        text.replace("\"version\": 1", "\"version\": 1.0"),
        text.replace("\"intervalSeconds\": 60", "\"intervalSeconds\": 29"),
        text.replace("\"root\"", "\"-root\""),
        text.replace("\"gpuExecutable\": null", "\"gpuExecutable\": \"relative\""),
        text.replace(", \"gpuExecutable\": null", ""),
        text.replace("\"mode\"", "\"mode\": 1, \"mode\""),
    ] {
        assert!(
            parse_observation_config(broken.as_bytes()).is_err(),
            "{broken}"
        );
    }
}

/// A fixed in-memory state directory for projection tests.
struct Memory(Vec<(String, Vec<u8>)>);
impl HistorySource for Memory {
    fn entries(&mut self) -> Result<Vec<String>, HistoryRefused> {
        Ok(self.0.iter().map(|(name, _)| name.clone()).collect())
    }
    fn read(&mut self, name: &str) -> Result<Vec<u8>, HistoryRefused> {
        Ok(self
            .0
            .iter()
            .find(|(known, _)| known == name)
            .unwrap()
            .1
            .clone())
    }
    fn tail(&mut self, name: &str) -> Result<Tail, HistoryRefused> {
        let data = self.read(name)?;
        Ok(Tail {
            charged: data.len(),
            data,
            complete: true,
        })
    }
    fn expired(&self) -> bool {
        false
    }
    fn recheck(&mut self) -> Result<(), HistoryRefused> {
        Ok(())
    }
}

#[test]
fn combine_preserves_python_number_types_and_rounding() {
    let config = parse_observation_config(br#"{"version":1,"mode":"user-observations","stateDirectory":"/h/s","intervalSeconds":60,"retentionDays":1,"rollupRetentionDays":1,"drives":{},"gpuExecutable":null}"#).unwrap();
    let day = 1_794_009_600;
    let rows = format!(
        "{{\"t\":{a},\"cpu_pct\":12,\"mem_pct\":{{\"min\":1,\"avg\":2.5,\"max\":3,\"n\":2}}}}\n{{\"t\":{b},\"cpu_pct\":12.0,\"mem_pct\":1.0}}\nnot json\n",
        a = day + 10,
        b = day + 20
    );
    let mut source = Memory(vec![("samples-2026-11-07.jsonl".into(), rows.into_bytes())]);
    let request = HistoryRequest {
        start: day,
        end: day + 60,
        resolution: "minute".into(),
        gpu: None,
        now: day + 61,
    };
    let output = String::from_utf8(query(&mut source, &config, &request).unwrap()).unwrap();
    // min/max keep the first minimal int 12; avg is (12*1 + 12.0*1)/2 rounded, a float.
    assert!(
        output.contains("\"cpu_pct\":{\"min\":12,\"avg\":12.0,\"max\":12,\"n\":2}"),
        "{output}"
    );
    // mem: (2.5*2 + 1.0*1)/3 = 2.0 exactly; min 1 (int) before 1.0, max 3.
    assert!(
        output.contains("\"mem_pct\":{\"min\":1,\"avg\":2.0,\"max\":3,\"n\":3}"),
        "{output}"
    );
    assert!(output.contains("\"malformedLines\":1,"), "{output}");
    assert!(
        output.starts_with("{\"version\":1,\"scope\":\"shared-host-unattributed-observations\"")
    );
    assert!(output.ends_with("\"historicalDeviceCoverage\":\"only-recorded-valid-UUIDs; legacy-rollups-have-no-device-history\"}"));
}

#[test]
fn queries_outside_bounds_are_refused() {
    let config = parse_observation_config(br#"{"version":1,"mode":"user-observations","stateDirectory":"/h/s","intervalSeconds":60,"retentionDays":1,"rollupRetentionDays":1,"drives":{},"gpuExecutable":null}"#).unwrap();
    let mut source = Memory(Vec::new());
    for (start, end, resolution, gpu) in [
        (10, 10, "auto", None),
        (0, 401 * 86400, "auto", None),
        (0, 60, "weekly", None),
        (0, 60, "auto", Some("GPU-XYZ")),
        (0, 2_000_000, "minute", None),
    ] {
        let request = HistoryRequest {
            start,
            end,
            resolution: resolution.into(),
            gpu: gpu.map(String::from),
            now: 100_000_000,
        };
        assert!(
            query(&mut source, &config, &request).is_err(),
            "{start} {end} {resolution}"
        );
    }
}
