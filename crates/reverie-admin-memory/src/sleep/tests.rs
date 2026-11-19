use super::*;
use serde_json::json;
use std::fs;

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        Self(nix::unistd::mkdtemp(&std::env::temp_dir().join("rv-sleep-unit-XXXXXX")).unwrap())
    }

    fn policy(&self, window: serde_json::Value, timezone: &str) -> Policy {
        let raw = json!({
            "timezone":timezone, "window":window, "chatrooms":self.0.join("missing-chat.json"),
            "state_dir":self.0, "agents":[{"name":"expert","instance":"/missing","session_id":"S1"}]
        });
        Policy::decode(&serde_json::to_vec(&raw).unwrap()).unwrap()
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn fixed_clock_respects_timezone_midnight_and_end_boundary() {
    let scratch = Scratch::new();
    let policy = scratch.policy(json!({"start":"22:00","end":"06:00"}), "America/New_York");
    let time = |value: &str| value.parse::<Timestamp>().unwrap();
    assert!(policy.in_window(time("2026-07-02T02:00:00Z")));
    assert!(policy.in_window(time("2026-07-02T09:59:00Z")));
    assert!(!policy.in_window(time("2026-07-02T10:00:00Z")));
    assert!(!policy.in_window(time("2026-07-01T16:00:00Z")));
    tick(&policy, time("2026-07-01T16:00:00Z")).unwrap();
    assert_eq!(
        fs::read_to_string(scratch.0.join("sleep.log")).unwrap(),
        "sleep v1 16:00:00 outside_window - 0 dry-run\n"
    );
    assert!(!scratch.0.join("sleep-expert.lock").exists());
}

#[test]
fn exhausted_budget_stops_before_opening_an_agent() {
    let scratch = Scratch::new();
    let policy = scratch.policy(json!({"start":"00:00","end":"00:00"}), "UTC");
    let mut report = Report::new(&scratch.0, "1970-01-01T00:00:00Z".parse().unwrap(), "live");
    let tick = Tick {
        policy: &policy,
        now: 0.0,
        rooms: Rooms::Json(vec![]),
        company: Company::default(),
        started: Instant::now()
            .checked_sub(PASS_BUDGET + Duration::from_secs(1))
            .unwrap(),
    };
    tick.run_agents(&mut report).unwrap();
    assert!(
        fs::read_to_string(scratch.0.join("sleep.log"))
            .unwrap()
            .contains("pass_budget_spent expert 0 live")
    );
    assert!(!scratch.0.join("sleep-expert.lock").exists());
}

#[test]
fn note_clipping_counts_characters_and_prefers_complete_sentences_or_lines() {
    let line = format!("{}\n{}", "é".repeat(400), "z".repeat(300));
    assert_eq!(memory::clip(&line, 600), "é".repeat(400));
    let sentence = format!("{}. {}", "é".repeat(400), "z".repeat(300));
    assert_eq!(
        memory::clip(&sentence, 600),
        format!("{}.", "é".repeat(400))
    );
    let word = "é".repeat(700);
    let clipped = memory::clip(&word, 600);
    assert_eq!(clipped.chars().count(), 600);
    assert!(clipped.ends_with('…'));
}

#[test]
fn new_reports_follow_a_rotated_log() {
    let scratch = Scratch::new();
    let path = scratch.0.join("sleep.log");
    let rotated = scratch.0.join("sleep.log.1");
    let time = "1970-01-01T00:00:00Z".parse().unwrap();
    let mut report = Report::new(&scratch.0, time, "live");
    assert!(!path.exists());
    report.line("rated", "expert", 2).unwrap();
    fs::rename(&path, &rotated).unwrap();
    report.line("reflected", "expert", 1).unwrap();
    assert!(
        fs::read_to_string(rotated)
            .unwrap()
            .contains("rated expert 2 live")
    );
    assert!(
        fs::read_to_string(path)
            .unwrap()
            .contains("reflected expert 1 live")
    );
}
