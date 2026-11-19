use super::Fixture;
use serde_json::json;
use std::{fs, os::unix::fs::PermissionsExt};

#[test]
fn pruning_preserves_unfinished_tails_and_uses_each_entry_mode() {
    let fixture = Fixture::new();
    let mut agent = fixture.agent("expert", None, false);
    agent["consolidate"] = json!(false);
    let live = fixture.0.join("live.jsonl");
    let preview = fixture.0.join("preview.jsonl");
    let valid = "{\"at\":\"2099-01-01T02:00:00+00:00\"}\n";
    let old = "{\"at\":\"2000-01-01T00:00:00Z\"}\n";
    let tail = "{\"at\":";
    let input = format!("{old}malformed\n{valid}{tail}");
    fs::write(&live, &input).unwrap();
    fs::write(&preview, &input).unwrap();
    let mut policy = fixture.policy(&[agent]);
    policy["dry_run"] = json!(true);
    policy["prune"] = json!([{"path":live,"days":1,"live":true},{"path":preview,"days":1}]);
    let first = fixture.tick(&policy);
    assert!(first.contains("pruned live.jsonl 2 dry-run"));
    assert!(first.contains("would_prune preview.jsonl 2 dry-run"));
    assert_eq!(fs::read_to_string(&live).unwrap(), format!("{valid}{tail}"));
    assert_eq!(fs::read_to_string(&preview).unwrap(), input);
    assert_eq!(
        fs::metadata(&live).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let second = fixture.tick(&policy);
    assert!(second.contains("pruned live.jsonl 1 dry-run"));
    assert_eq!(fs::read_to_string(&live).unwrap(), valid);
}

#[test]
fn changed_tails_and_failed_entries_do_not_stop_the_pass() {
    let fixture = Fixture::new();
    let mut agent = fixture.agent("expert", None, false);
    agent["consolidate"] = json!(false);
    let left = fixture.0.join("left");
    let right = fixture.0.join("right");
    fs::create_dir(&left).unwrap();
    fs::create_dir(&right).unwrap();
    let a = left.join("log.jsonl");
    let b = right.join("log.jsonl");
    fs::write(&a, "tail").unwrap();
    fs::write(&b, "tail").unwrap();
    let mut policy = fixture.policy(&[agent]);
    policy["dry_run"] = json!(true);
    policy["prune"] = json!([{"path":left,"days":1,"live":true},
                           {"path":a,"days":1,"live":true},
                           {"path":b,"days":1,"live":true},
                           {"path":right.join("missing"),"days":1,"live":true}]);
    let first = fixture.tick(&policy);
    assert!(first.contains("error_prune_OSError left 0 dry-run"));
    assert!(first.contains("nothing_due expert 0 dry-run"));
    fs::write(&a, "longer tail").unwrap();
    fixture.tick(&policy);
    assert_eq!(fs::read_to_string(&a).unwrap(), "longer tail");
    assert_eq!(fs::read_to_string(&b).unwrap(), "");
}
