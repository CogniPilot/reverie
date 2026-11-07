//! argparse's split-argument rule at the process boundary: a value option
//! followed by a token argparse reads as an option exits 2 before any file
//! effect, while the `=` form and plain negative numbers are values.
use reverie_observations::receipts::{Prescan, prescan};
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

fn scan(list: &[&str]) -> Prescan {
    prescan(&list.iter().map(OsString::from).collect::<Vec<_>>())
}

/// The classification of each split token after a value option, as the
/// Python adapter's parser gave it (packet log argparse-probe-r2.txt).
#[test]
fn split_tokens_follow_the_argparse_classification() {
    // Taken as values; the last three then fail float(), as in Python.
    for (value, float) in [
        ("-1", true),
        ("-1.5", true),
        ("-.5", true),
        ("-1 ", true),
        ("-1\n", true),
        (" -1", true),
        ("5", true),
        ("-x y", false),
        ("-", false),
        ("", false),
    ] {
        let expected = if float {
            Prescan::Parse
        } else {
            Prescan::Usage(format!(
                "argument --max-age-days: invalid float value: '{value}'"
            ))
        };
        assert_eq!(scan(&["--max-age-days", value]), expected, "{value:?}");
    }
    for value in [
        "-1_000", "-5.", "-1e3", "-inf", "--", "-0x1", "--1", "-h", "--ma", "-1.5.2",
    ] {
        assert_eq!(
            scan(&["--max-entries", value]),
            Prescan::Usage("argument --max-entries: expected one argument".into()),
            "{value:?}"
        );
    }
    for value in ["-x y", "-", "", "-1", "--x"] {
        let expected = if value == "--x" {
            Prescan::Usage("argument --out: expected one argument".into())
        } else {
            Prescan::Parse
        };
        assert_eq!(scan(&["--out", value]), expected, "{value:?}");
    }
    assert_eq!(
        scan(&["--max-e", "-inf"]),
        Prescan::Usage("argument --max-entries: expected one argument".into())
    );
    assert_eq!(
        scan(&["--max-entries=-inf"]),
        Prescan::Usage("argument --max-entries: invalid int value: '-inf'".into())
    );
    assert_eq!(scan(&["--max-entries=-1_000"]), Prescan::Parse);
    assert_eq!(scan(&["--out", "-1", "--a1", "x"]), Prescan::Parse);
}

/// argparse's left-to-right order around help, as the Python adapter gave it
/// (packet log help-probe.txt): (arguments, exit code).
const HELP_ORDER: [(&[&str], i32); 28] = [
    (&["--help", "--max-entries", "-1_000"], 0),
    (&["--max-entries", "-1_000", "--help"], 2),
    (&["--help", "--ma"], 0),
    (&["--ma", "--help"], 2),
    (&["--he", "--max-entries", "-1_000"], 0),
    (&["--h", "--max-entries", "-inf"], 0),
    (&["-h", "--max-entries", "-inf"], 0),
    (&["--out", "o.jsonl", "--help"], 0),
    (&["--out", "--help"], 2),
    (&["--help=x"], 2),
    (&["--help", "--out"], 0),
    (&["--help", "--bogus"], 0),
    (&["--bogus", "--help"], 0),
    (&["--help", "--", "--max-entries", "-1"], 0),
    (&["--max-entries", "-1", "--help", "--max-bytes", "-1e3"], 0),
    (&["--help", "--max-entries=abc"], 0),
    (&["--max-entries", "abc", "--help"], 2),
    (&["--max-entries=abc", "--help"], 2),
    (&["-hx"], 0),
    (&["x", "--help"], 0),
    (&["--", "--help"], 2),
    // The cases named in review, and help-looking values (help-probe-r2.txt).
    (&["--help", "--max-entries", "-inf"], 0),
    (
        &["--out", "out.jsonl", "--help", "--max-entries", "-1_000"],
        0,
    ),
    (&["--out=--help", "--max-entries", "-1_000"], 2),
    (&["--out=-h"], 0),
    (&["--out", "-h x", "--max-entries", "-1_000"], 2),
    (
        &[
            "--context=--help",
            "--out",
            "o.jsonl",
            "--max-entries",
            "-inf",
        ],
        2,
    ),
    (&["--a1", "--help"], 2),
];

#[test]
fn help_and_usage_errors_follow_argparse_order_without_file_effects() {
    for (args, code) in HELP_ORDER {
        let root = directory("help");
        let (status, stdout) = run(&root, args);
        assert_eq!(status, code, "{args:?}");
        assert_eq!(
            !stdout.is_empty(),
            code == 0,
            "{args:?}: help is printed only on 0"
        );
        assert_eq!(
            fs::read_to_string(root.join("out.jsonl")).unwrap(),
            EXISTING,
            "{args:?}"
        );
        assert_eq!(names(&root), ["out.jsonl"], "{args:?}");
        let _ = fs::remove_dir_all(&root);
    }
    // Python's int() accepts an integer beyond 64 bits, so a later help wins.
    assert_eq!(
        scan(&["--max-entries", "99999999999999999999", "--help"]),
        Prescan::Help
    );
    assert_eq!(scan(&["--max-age-days", "nan", "--help"]), Prescan::Help);
}
