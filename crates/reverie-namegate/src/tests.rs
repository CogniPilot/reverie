//! Parity with the reference gate (Python 3.13, Unicode 15.1) on placeholder lists, exhaustive
//! character-class parity, and fail-closed list handling. No real list material is used.

use super::{Category, Kind, ListError, Lists, classes, clean, hits, locate, scan};
use serde_json::Value;
use sha2::{Digest, Sha256};

const LISTS: &str = include_str!("../tests/fixtures/placeholder-lists.json");
const PARITY: &str = include_str!("../tests/fixtures/parity.json");
const CLASSES: &str = include_str!("../tests/fixtures/classes.json");

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn lists() -> Lists {
    Lists::from_bytes(LISTS.as_bytes(), &digest(LISTS.as_bytes())).expect("placeholder lists load")
}

fn ranges(table: &Value) -> Vec<(u32, u32)> {
    table
        .as_array()
        .expect("range table")
        .iter()
        .map(|pair| {
            (
                pair[0].as_u64().expect("start") as u32,
                pair[1].as_u64().expect("end") as u32,
            )
        })
        .collect()
}

fn contains(ranges: &[(u32, u32)], cp: u32) -> bool {
    ranges
        .binary_search_by(|&(lo, hi)| {
            if hi < cp {
                std::cmp::Ordering::Less
            } else if lo > cp {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

#[test]
fn character_classes_match_the_reference_for_every_assigned_code_point() {
    let tables: Value = serde_json::from_str(CLASSES).expect("class tables");
    let unassigned = ranges(&tables["unassigned"]);
    type Predicate = fn(char) -> bool;
    let checks: [(&str, Predicate); 5] = [
        ("word", classes::is_word),
        ("decimal", classes::is_decimal),
        ("space", classes::is_space),
        ("letter_run", classes::is_letter_run),
        ("format", classes::is_format),
    ];
    for (name, predicate) in checks {
        let expected = ranges(&tables[name]);
        let mismatches: Vec<u32> = (0..=0x10_ffff_u32)
            .filter(|&cp| !contains(&unassigned, cp))
            .filter_map(|cp| char::from_u32(cp).map(|ch| (cp, ch)))
            .filter(|&(cp, ch)| predicate(ch) != contains(&expected, cp))
            .map(|(cp, _)| cp)
            .collect();
        assert!(
            mismatches.is_empty(),
            "{name}: {} mismatches, first {:x?}",
            mismatches.len(),
            &mismatches[..mismatches.len().min(8)]
        );
    }
}

#[test]
fn ignorecase_matches_the_reference_for_every_list_letter() {
    let tables: Value = serde_json::from_str(CLASSES).expect("class tables");
    for (letter, matching) in tables["ignorecase"].as_object().expect("ignorecase table") {
        let pattern = letter.chars().next().expect("letter");
        let expected: Vec<u32> = matching
            .as_array()
            .expect("code points")
            .iter()
            .map(|v| v.as_u64().expect("cp") as u32)
            .collect();
        let actual: Vec<u32> = (0..=0x10_ffff_u32)
            .filter_map(char::from_u32)
            .filter(|&ch| classes::ignorecase_eq(pattern, ch))
            .map(u32::from)
            .collect();
        assert_eq!(actual, expected, "re.I class for {letter}");
    }
}

fn encode(findings: &[super::Finding]) -> Value {
    Value::Array(
        findings
            .iter()
            .map(|f| serde_json::json!([category_name(f.category), f.index, f.in_blob]))
            .collect(),
    )
}

fn category_name(category: Category) -> &'static str {
    category.name()
}

#[test]
fn every_parity_case_matches_the_reference() {
    let lists = lists();
    let corpus: Value = serde_json::from_str(PARITY).expect("parity corpus");
    assert_eq!(
        corpus["lists_sha256"].as_str(),
        Some(lists.digest()),
        "corpus was generated from these lists"
    );
    let modes = [
        ("text", Kind::Text, "other"),
        ("text", Kind::Text, "acmeproj"),
        ("code", Kind::Code, "other"),
        ("code", Kind::Code, "acmeproj"),
    ];
    let failures: Vec<String> = corpus["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .enumerate()
        .flat_map(|(n, case)| modes.iter().map(move |mode| (n, case, mode)))
        .filter_map(|(n, case, &(kind_name, kind, repo))| {
            let text = case["text"].as_str().expect("text");
            let expected = &case[format!("{kind_name}/{repo}")];
            let outcome = scan(&lists, text, kind, repo);
            let actual = serde_json::json!({
                "blocking": encode(&outcome.blocking),
                "flagged": encode(&outcome.flagged),
                "hits": encode(&hits(&lists, text, kind, repo)),
            });
            (&actual != expected)
                .then(|| format!("case {n} {kind_name}/{repo}: expected {expected} got {actual}"))
        })
        .collect();
    assert!(
        failures.is_empty(),
        "{} parity failures; first: {}",
        failures.len(),
        failures
            .iter()
            .take(5)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn strict_base64_matches_the_reference_padding_rules() {
    let data = "QUJDQUJDQUJD";
    for n in 0..=8 {
        for padding in 0..=2 {
            let text = format!("{}{}", &data[..n], "=".repeat(padding));
            let valid = matches!((n % 4, padding), (0, 0) | (2, 2) | (3, 1));
            assert_eq!(clean::strict_base64(&text).is_some(), valid, "{text:?}");
        }
    }
    assert_eq!(
        clean::strict_base64("QR=="),
        Some(vec![0x41]),
        "trailing bits are ignored"
    );
    assert_eq!(clean::strict_base64("QQ==QQ=="), None);
    assert_eq!(clean::strict_base64(""), Some(vec![]));
}

fn with(field: &str, value: Value) -> Vec<u8> {
    let mut parsed: Value = serde_json::from_str(LISTS).expect("lists");
    parsed[field] = value;
    serde_json::to_vec(&parsed).expect("serialize")
}

fn load(bytes: &[u8]) -> Result<Lists, ListError> {
    Lists::from_bytes(bytes, &digest(bytes))
}

#[test]
fn list_file_problems_fail_closed() {
    let good = LISTS.as_bytes();
    assert_eq!(
        Lists::from_bytes(good, &"0".repeat(64)).err(),
        Some(ListError::DigestMismatch)
    );
    assert_eq!(
        Lists::from_bytes(good, "abc").err(),
        Some(ListError::BadDigestArgument)
    );
    assert_eq!(
        Lists::from_bytes(good, &digest(good).to_uppercase()).err(),
        Some(ListError::BadDigestArgument)
    );
    assert!(matches!(
        Lists::load(
            std::path::Path::new("/nonexistent/lists.json"),
            &digest(good)
        ),
        Err(ListError::Unreadable(_))
    ));
    for category in [
        "team",
        "internal",
        "ai_words",
        "ai_phrases",
        "path_markers",
        "allow",
    ] {
        assert_eq!(
            load(&with(category, serde_json::json!([]))).err(),
            Some(ListError::EmptyCategory(category)),
            "{category}"
        );
    }
    assert_eq!(
        load(&with("home_repo", serde_json::json!(""))).err(),
        Some(ListError::EmptyCategory("home_repo"))
    );
    assert_eq!(
        load(&with("team", serde_json::json!(["ok", "Upper"]))).err(),
        Some(ListError::BadEntry("team", 1))
    );
    assert_eq!(
        load(&with("team", serde_json::json!(["two words"]))).err(),
        Some(ListError::BadEntry("team", 0))
    );
    assert_eq!(
        load(&with("path_markers", serde_json::json!(["a{b}"]))).err(),
        Some(ListError::BadEntry("path_markers", 0))
    );
    assert_eq!(
        load(&with("schema", serde_json::json!(2))).err(),
        Some(ListError::Schema(2))
    );
    assert!(matches!(
        load(&with("extra", serde_json::json!(1))),
        Err(ListError::Malformed(_))
    ));
    assert!(matches!(load(b"not json"), Err(ListError::Malformed(_))));
}

#[test]
fn reports_digest_and_counts_without_entries() {
    let lists = lists();
    assert_eq!(lists.digest(), digest(LISTS.as_bytes()));
    assert_eq!(lists.counts(), [14, 1, 4, 2, 4, 5]);
    let rendered = format!("{:?}", scan(&lists, "elm birch", Kind::Text, "other"));
    assert!(
        !rendered.contains("elm") && !rendered.contains("birch"),
        "findings never carry matched text"
    );
}

#[test]
fn locate_reports_columns_in_normalised_text_without_text() {
    let lists = lists();
    let found = locate(&lists, "ok elm and birch", Kind::Text, "other");
    let columns: Vec<(&str, usize, usize)> = found
        .iter()
        .map(|(f, col)| (f.category.name(), f.index, *col))
        .collect();
    assert_eq!(columns, vec![("team", 1, 12), ("team", 4, 4)]);
    let zero_width = locate(&lists, "x el\u{200b}m", Kind::Text, "other");
    assert_eq!(zero_width.len(), 1);
    assert_eq!(
        zero_width[0].1, 3,
        "column after dropping the format character"
    );
}
