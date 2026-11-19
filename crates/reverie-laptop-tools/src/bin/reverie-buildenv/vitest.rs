use regex_lite::Regex;
use std::{path::Path, sync::LazyLock};

static FILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\.(test|spec)\.[cm]?[jt]sx?$").unwrap());
static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap());
static SUMMARY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*Test Files\s.*\(([0-9]+)\)\s*$").unwrap());
const ENTRY_POINTS: &[&str] = &["vitest", "vitest.mjs", "vitest.js"];
const OPTIONS_WITH_VALUE: &[&str] = &[
    "-c",
    "--config",
    "-r",
    "--root",
    "--dir",
    "--project",
    "--reporter",
    "--outputFile",
    "--pool",
    "--environment",
    "-t",
    "--testNamePattern",
    "--exclude",
    "--shard",
    "--mode",
    "--workspace",
];

pub(super) fn summary(output: &[u8]) -> Option<usize> {
    let output = String::from_utf8_lossy(output);
    let clean = ANSI.replace_all(&output, "");
    SUMMARY
        .captures_iter(&clean)
        .last()?
        .get(1)?
        .as_str()
        .parse()
        .ok()
}

fn count_test_files(command: &[String], repo: &Path) -> usize {
    let tail = command.get(1..).unwrap_or_default();
    let args = tail
        .iter()
        .position(|arg| {
            Path::new(arg)
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| ENTRY_POINTS.contains(&name))
        })
        .map_or(tail, |index| &tail[index + 1..]);
    let mut args = args.iter().peekable();
    if args.peek().is_some_and(|arg| *arg == "run") {
        args.next();
    }
    let mut count = 0;
    while let Some(arg) = args.next() {
        if arg.starts_with('-') {
            if OPTIONS_WITH_VALUE.contains(&arg.as_str()) {
                args.next();
            }
        } else if FILE.is_match(arg) || repo.join(arg).is_file() {
            count += 1;
        }
    }
    count
}

pub(super) fn expected(value: &str, command: &[String], repo: &Path) -> Result<usize, String> {
    let count = if value == "auto" {
        count_test_files(command, repo)
    } else {
        value
            .parse()
            .ok()
            .filter(|_| value.bytes().all(|byte| byte.is_ascii_digit()))
            .ok_or("--expect-files takes a count or 'auto'")?
    };
    if count == 0 {
        return Err("--expect-files needs at least one test file (auto found none: give N)".into());
    }
    Ok(count)
}
