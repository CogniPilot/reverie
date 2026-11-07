//! `cargo xtask namegate`: scans outbound text with a private, pinned list file and prints only
//! categories, locations and list indices, never what matched.

use reverie_namegate::{CATEGORIES, Finding, Kind, Lists, locate, scan};
use std::error::Error;
use std::io::Read;
use std::path::PathBuf;

pub(crate) const USAGE: &str = "cargo xtask namegate --lists FILE --lists-sha256 HEX --repo NAME --kind text|code [--strict] [FILE...]\n  Scan files (or stdin) with the private name lists. Prints category, file:line:col and list\n  index only. Exits nonzero on any blocking finding (with --strict, also on blob findings) and\n  on any missing, altered or empty list file.";

struct Options {
    lists: PathBuf,
    pin: String,
    repo: String,
    kind: Kind,
    strict: bool,
    inputs: Vec<String>,
}

pub(crate) fn run(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    let options = parse(arguments)?;
    let lists = Lists::load(&options.lists, &options.pin)?;
    let counts: Vec<String> = CATEGORIES
        .iter()
        .zip(lists.counts())
        .map(|(name, count)| format!("{name}={count}"))
        .collect();
    println!(
        "namegate: lists sha256 {} {}",
        lists.digest(),
        counts.join(" ")
    );
    let (mut failing, mut flagged) = (0, 0);
    for input in inputs(&options.inputs)? {
        let (fails, flags) = report(&lists, &options, &input)?;
        failing += fails;
        flagged += flags;
    }
    if failing > 0 {
        return Err(format!("namegate: {failing} finding(s) block this text").into());
    }
    println!("namegate: no blocking findings ({flagged} flagged for a manual check)");
    Ok(())
}

fn parse(arguments: &[String]) -> Result<Options, Box<dyn Error>> {
    let (mut lists, mut pin, mut repo, mut kind) = (None, None, None, None);
    let mut strict = false;
    let mut inputs = Vec::new();
    let mut rest = arguments.iter();
    while let Some(argument) = rest.next() {
        let mut value = || {
            rest.next()
                .cloned()
                .ok_or(format!("{argument} needs a value"))
        };
        match argument.as_str() {
            "--lists" => lists = Some(PathBuf::from(value()?)),
            "--lists-sha256" => pin = Some(value()?),
            "--repo" => repo = Some(value()?),
            "--kind" => kind = Some(parse_kind(&value()?)?),
            "--strict" => strict = true,
            flag if flag.starts_with("--") => {
                return Err(format!("unknown option {flag}\n{USAGE}").into());
            }
            input => inputs.push(input.to_owned()),
        }
    }
    let missing = |name: &str| format!("{name} is required\n{USAGE}");
    Ok(Options {
        lists: lists.ok_or_else(|| missing("--lists"))?,
        pin: pin.ok_or_else(|| missing("--lists-sha256"))?,
        repo: repo.ok_or_else(|| missing("--repo"))?,
        kind: kind.ok_or_else(|| missing("--kind"))?,
        strict,
        inputs,
    })
}

fn parse_kind(value: &str) -> Result<Kind, Box<dyn Error>> {
    match value {
        "text" => Ok(Kind::Text),
        "code" => Ok(Kind::Code),
        other => Err(format!("--kind must be text or code, not {other:?}").into()),
    }
}

/// (label, contents) pairs; no files means stdin, labelled `-`.
fn inputs(paths: &[String]) -> Result<Vec<(String, String)>, Box<dyn Error>> {
    if paths.is_empty() {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text)?;
        return Ok(vec![("-".to_owned(), text)]);
    }
    paths
        .iter()
        .map(|path| Ok((path.clone(), std::fs::read_to_string(path)?)))
        .collect()
}

/// Prints each finding of one input and returns (failing, flagged-only) counts. The decision
/// comes from scanning the whole input; lines only supply locations.
fn report(
    lists: &Lists,
    options: &Options,
    (label, text): &(String, String),
) -> Result<(usize, usize), Box<dyn Error>> {
    let outcome = scan(lists, text, options.kind, &options.repo);
    let located: Vec<(usize, Finding, usize)> = text
        .lines()
        .enumerate()
        .flat_map(|(n, line)| {
            locate(lists, line, options.kind, &options.repo)
                .into_iter()
                .map(move |(finding, column)| (n + 1, finding, column))
        })
        .collect();
    let position = |finding: &Finding| {
        located
            .iter()
            .find(|(_, found, _)| found == finding)
            .map_or_else(
                || "?:?".to_owned(),
                |(line, _, column)| format!("{line}:{column}"),
            )
    };
    let mut failing = 0;
    for (finding, blocks) in outcome.blocking.iter().map(|f| (f, true)).chain(
        outcome
            .flagged
            .iter()
            .map(|f| (f, options.strict && f.in_blob)),
    ) {
        let severity = if blocks { "block" } else { "flag" };
        let blob = if finding.in_blob { " blob" } else { "" };
        println!(
            "{label}:{}: {severity} {}{blob} entry {}",
            position(finding),
            finding.category.name(),
            finding.index
        );
        failing += usize::from(blocks);
    }
    let total = outcome.blocking.len() + outcome.flagged.len();
    Ok((failing, total - failing))
}
