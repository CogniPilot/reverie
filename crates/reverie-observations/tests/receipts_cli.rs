//! argparse's split-argument rule at the process boundary: a value option
//! followed by a token argparse reads as an option exits 2 before any file
//! effect, while the `=` form and plain negative numbers are values.
use reverie_observations::receipts::refused_split_value;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const EXISTING: &str =
    "{\"receipt_id\": \"a\"}\n{\"receipt_id\": \"b\"}\n{\"receipt_id\": \"c\"}\n";

fn directory(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("receipts-cli-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("out.jsonl"), EXISTING).unwrap();
    root
}

fn run(root: &Path, args: &[&str]) -> (i32, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_reverie-prune-receipts"))
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    (
        output.status.code().unwrap(),
        String::from_utf8(output.stdout).unwrap(),
    )
}

fn names(root: &Path) -> Vec<String> {
    let mut names = fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect::<Vec<_>>();
    names.sort();
    names
}

#[test]
fn refused_split_values_change_no_file() {
    for args in [
        ["--out", "out.jsonl", "--max-entries", "-1_000"],
        ["--out", "out.jsonl", "--max-age-days", "-inf"],
        ["--out", "out.jsonl", "--max-bytes", "-1e3"],
        ["--max-entries", "-1", "--out", "--a1"],
    ] {
        let root = directory("refused");
        assert_eq!(run(&root, &args), (2, String::new()), "{args:?}");
        assert_eq!(
            fs::read_to_string(root.join("out.jsonl")).unwrap(),
            EXISTING
        );
        assert_eq!(names(&root), ["out.jsonl"], "{args:?}");
        let _ = fs::remove_dir_all(&root);
    }
}

#[test]
fn equals_forms_and_plain_negative_numbers_are_values() {
    // --max-entries=-1_000: keep[1000:] drops all three, then the drop record.
    let root = directory("equals");
    let (code, line) = run(&root, &["--out", "out.jsonl", "--max-entries=-1_000"]);
    assert_eq!(code, 0);
    assert!(line.contains("\"retention_dropped\": 3"), "{line}");
    let text = fs::read_to_string(root.join("out.jsonl")).unwrap();
    assert_eq!(text.lines().count(), 1);
    assert!(text.contains("\"event_kind\":\"RETENTION_DROP\""));
    let _ = fs::remove_dir_all(&root);
    // --max-entries -1: keep[1:] drops the first record only.
    let root = directory("negative");
    let (code, line) = run(&root, &["--out", "out.jsonl", "--max-entries", "-1"]);
    assert_eq!(code, 0);
    assert!(line.contains("\"retention_dropped\": 1"), "{line}");
    let text = fs::read_to_string(root.join("out.jsonl")).unwrap();
    assert!(text.starts_with("{\"receipt_id\": \"b\"}\n{\"receipt_id\": \"c\"}\n"));
    let _ = fs::remove_dir_all(&root);
    // A path may start with a hyphen when argparse reads it as a value.
    let root = directory("path");
    assert_eq!(run(&root, &["--out", "-1"]).0, 0);
    let _ = fs::remove_dir_all(&root);
}

/// The classification of each split token after a value option, as the
/// Python adapter's parser gave it (packet log argparse-probe-r2.txt).
#[test]
fn split_tokens_follow_the_argparse_classification() {
    let refused = |value: &str| {
        let args = [OsString::from("--max-entries"), OsString::from(value)];
        refused_split_value(&args).is_some()
    };
    for value in [
        "-1", "-1.5", "-.5", "-x y", "-", "-1 ", "-1\n", " -1", "5", "",
    ] {
        assert!(!refused(value), "{value:?}");
    }
    for value in [
        "-1_000", "-5.", "-1e3", "-inf", "--", "-0x1", "--1", "-h", "--ma", "-1.5.2",
    ] {
        assert!(refused(value), "{value:?}");
    }
    let args = |list: &[&str]| list.iter().map(OsString::from).collect::<Vec<_>>();
    assert_eq!(
        refused_split_value(&args(&["--max-entries"])),
        Some("--max-entries")
    );
    assert_eq!(
        refused_split_value(&args(&["--max-e", "-inf"])),
        Some("--max-entries")
    );
    assert_eq!(refused_split_value(&args(&["--max-entries=-inf"])), None);
    assert_eq!(
        refused_split_value(&args(&["--out", "-1", "--a1", "x"])),
        None
    );
}
