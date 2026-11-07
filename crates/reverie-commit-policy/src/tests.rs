//! Parity with the reference (`reverie.governance`), whose unmodified outputs for every input
//! below are recorded in the fixture, plus the deliberate narrowings.

use super::{
    Error, Staged, added_lines, check_anonymity, check_commit, check_review, dumps, dumps_fields,
    glob, merge_decision, py, review_context, valid_message, violations,
};
use serde_json::{Map, Value, json};
use sha2::Digest;

const REFERENCE: &str = include_str!("../tests/fixtures/governance-reference.json");

fn reference() -> (Value, Value) {
    let mut parsed: Value = serde_json::from_str(REFERENCE).expect("reference fixture");
    (parsed["inputs"].take(), parsed["outputs"].take())
}

fn map(value: &Value) -> Map<String, Value> {
    value.as_object().expect("object").clone()
}

fn outcome(result: Result<Value, Error>) -> Value {
    match result {
        Ok(value) => json!({"ok": value}),
        Err(Error::Policy(reason)) => json!({"policy": reason}),
        Err(Error::Malformed(_)) => json!({"malformed": true}),
    }
}

/// The reference reports its exception type for malformed input; only the category is compared.
fn normalise(expected: &Value) -> Value {
    if expected.get("malformed").is_some() {
        json!({"malformed": true})
    } else {
        expected.clone()
    }
}

fn rows(found: Vec<super::Violation>) -> Value {
    json!(
        found
            .into_iter()
            .map(|v| json!([v.place, v.line, v.name]))
            .collect::<Vec<_>>()
    )
}

fn compare(name: &str, cases: Vec<(String, Value, Value)>) {
    let failures: Vec<String> = cases
        .into_iter()
        .filter(|(_, want, got)| normalise(want) != *got)
        .map(|(case, want, got)| format!("{case}: expected {want} got {got}"))
        .collect();
    assert!(
        failures.is_empty(),
        "{name}: {} mismatches\n{}",
        failures.len(),
        failures
            .iter()
            .take(8)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn messages_match_the_reference() {
    let (inputs, outputs) = reference();
    let policies = inputs["message_policies"].as_array().expect("policies");
    let mut cases = Vec::new();
    for (m, message) in inputs["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .enumerate()
    {
        for (p, policy) in policies.iter().enumerate() {
            let got = outcome(
                valid_message(message.as_str().expect("message"), &map(policy))
                    .map(|()| Value::Null),
            );
            cases.push((
                format!("message {m} policy {p}"),
                outputs["messages"][m][p].clone(),
                got,
            ));
        }
    }
    compare("messages", cases);
}

#[test]
fn anonymity_matches_the_reference_for_text_and_diffs() {
    let (inputs, outputs) = reference();
    let policies = inputs["anonymity_policies"].as_array().expect("policies");
    let mut cases = Vec::new();
    for (t, text) in inputs["texts"]
        .as_array()
        .expect("texts")
        .iter()
        .enumerate()
    {
        let text = text.as_str().expect("text");
        for (p, policy) in policies.iter().enumerate() {
            let policy = map(policy);
            let found = outcome(violations(&policy, Some(text), None).map(rows));
            cases.push((
                format!("text {t} policy {p}"),
                outputs["texts"][t][p].clone(),
                found,
            ));
            let checked = outcome(check_anonymity(&policy, Some(text), None).map(|()| Value::Null));
            cases.push((
                format!("check text {t} policy {p}"),
                outputs["text_checks"][t][p].clone(),
                checked,
            ));
        }
    }
    for (d, diff) in inputs["diffs"]
        .as_array()
        .expect("diffs")
        .iter()
        .enumerate()
    {
        let diff = diff.as_str().expect("diff");
        for (p, policy) in policies.iter().enumerate() {
            let found = outcome(violations(&map(policy), None, Some(diff)).map(rows));
            cases.push((
                format!("diff {d} policy {p}"),
                outputs["diffs"][d][p].clone(),
                found,
            ));
        }
        let added = outcome(added_lines(diff).map(|lines| {
            json!(
                lines
                    .into_iter()
                    .map(|(path, line, text)| json!([path, line, text]))
                    .collect::<Vec<_>>()
            )
        }));
        cases.push((format!("added {d}"), outputs["added"][d].clone(), added));
    }
    compare("anonymity", cases);
}

#[test]
fn globs_match_the_reference() {
    let (inputs, outputs) = reference();
    let cases = inputs["globs"]
        .as_array()
        .expect("globs")
        .iter()
        .enumerate()
        .map(|(g, pair)| {
            let (name, pattern) = (
                pair[0].as_str().expect("name"),
                pair[1].as_str().expect("pattern"),
            );
            (
                format!("glob {g} {name:?} {pattern:?}"),
                outputs["globs"][g].clone(),
                json!(glob::fnmatchcase(name, pattern)),
            )
        })
        .collect();
    compare("globs", cases);
}

#[test]
fn reviews_match_the_reference() {
    let (inputs, outputs) = reference();
    let cases = inputs["reviews"]
        .as_array()
        .expect("reviews")
        .iter()
        .enumerate()
        .map(|(r, case)| {
            let directives = case[3].as_array().expect("directives").clone();
            let got = outcome(
                check_review(&map(&case[0]), &case[1], &case[2], &directives).map(|()| Value::Null),
            );
            (format!("review {r}"), outputs["reviews"][r].clone(), got)
        })
        .collect();
    compare("reviews", cases);
}

/// Applies one case's overrides the way the fixture command does: shallow updates of the base
/// snapshot and review, and of the repository policy, where `null` removes a key.
fn merge_case(
    inputs: &Value,
    overrides: &Value,
) -> (Map<String, Value>, Map<String, Value>, Map<String, Value>) {
    let mut pr = map(&inputs["merge_pr"]);
    pr.extend(map(&overrides[0]));
    let mut review = map(&inputs["merge_review"]);
    review.extend(map(&overrides[1]));
    let mut policy = map(&inputs["merge_policy"]);
    let mut repositories = map(&policy["repositories"]);
    let mut repo = map(&repositories["o/r"]);
    for (key, value) in map(&overrides[2]) {
        if value.is_null() {
            repo.remove(&key);
        } else {
            repo.insert(key, value);
        }
    }
    repositories.insert("o/r".into(), Value::Object(repo));
    policy.insert("repositories".into(), Value::Object(repositories));
    (pr, review, policy)
}

#[test]
fn merge_decisions_match_the_reference() {
    let (inputs, outputs) = reference();
    let cases = inputs["merges"]
        .as_array()
        .expect("merges")
        .iter()
        .enumerate()
        .map(|(m, overrides)| {
            let (pr, review, policy) = merge_case(&inputs, overrides);
            let got = outcome(merge_decision(&pr, &review, &policy).map(|decision| {
                json!(
                    decision
                        .fields()
                        .into_iter()
                        .map(|(key, value)| json!([key, value]))
                        .collect::<Vec<_>>()
                )
            }));
            (format!("merge {m}"), outputs["merges"][m].clone(), got)
        })
        .collect();
    compare("merges", cases);
}

#[test]
fn review_context_matches_the_reference() {
    let (inputs, outputs) = reference();
    let cases = inputs["contexts"]
        .as_array()
        .expect("contexts")
        .iter()
        .enumerate()
        .map(|(c, case)| {
            let project = case[1].as_object().cloned();
            let got = outcome(review_context(&map(&case[0]), project.as_ref()).map(Value::String));
            // Named wording difference: the line no longer spells out the trailer key.
            let want: Value = serde_json::from_str(
                &outputs["contexts"][c]
                    .to_string()
                    .replace("no AI Paired-with trailers.", "no AI co-author trailers."),
            )
            .expect("context");
            (format!("context {c}"), want, got)
        })
        .collect();
    compare("contexts", cases);
}

#[test]
fn author_patterns_beyond_literal_text_are_refused() {
    for pattern in [
        "cl.ude",
        "bot$",
        "(a|b)",
        "\\w+",
        "[bot]",
        "na\u{ef}ve",
        "\\ ",
    ] {
        let policy = map(
            &json!({"commits": {"no_ai_coauthors": true, "ai_author_patterns": [pattern], "ai_author_trailers": ["Paired-with"]}}),
        );
        assert!(
            matches!(
                valid_message("Paired-with: x\n", &policy),
                Err(Error::Malformed(_))
            ),
            "{pattern}"
        );
    }
    let policy =
        map(&json!({"commits": {"no_ai_coauthors": true, "ai_author_patterns": "helper"}}));
    assert!(matches!(
        valid_message("x", &policy),
        Err(Error::Malformed(_))
    ));
}

#[test]
fn check_commit_orders_anonymity_review_then_message() {
    let policy = map(&json!({
        "agent_anonymity": {"agent_names": ["Alpha"]},
        "commits": {"require_review": true, "dco_signoff": true},
        "review_directives": [{"id": "D1", "instruction": "x"}],
    }));
    let receipt = map(&json!({
        "revision": "T1", "approved": true, "reviewer": "rev-a",
        "covered_directives": ["D1"], "evidence": "log",
    }));
    let staged = Staged {
        tree: "T1",
        diff: "+++ b/a.rs\n@@ -0,0 +1 @@\n+ok\n",
        author: "impl-a",
    };
    let signed = "Fix\n\nSigned-off-by: J <j@x>\n";
    assert_eq!(
        check_commit(&policy, &receipt, Some(signed), &staged),
        Ok("T1".into())
    );
    let named = Staged {
        diff: "+++ b/a.rs\n@@ -0,0 +1 @@\n+Alpha\n",
        ..staged
    };
    assert_eq!(
        check_commit(&policy, &receipt, Some("Fix\n"), &named),
        Err(Error::Policy(
            "agent names are not allowed by owner policy (agent_anonymity): a.rs:1 Alpha".into()
        ))
    );
    let other = Staged {
        tree: "T2",
        ..staged
    };
    assert_eq!(
        check_commit(&policy, &receipt, Some("Fix\n"), &other),
        Err(Error::Policy(
            "review does not match the current revision".into()
        ))
    );
    assert_eq!(
        check_commit(&policy, &receipt, Some("Fix\n"), &staged),
        Err(Error::Policy(
            "a DCO Signed-off-by trailer is required; use git commit -s".into()
        ))
    );
    assert_eq!(
        check_commit(&policy, &receipt, None, &staged),
        Ok("T1".into())
    );
    assert_eq!(
        check_commit(&Map::new(), &Map::new(), Some("Alpha\n"), &named),
        Ok("T1".into())
    );
}

#[test]
fn output_matches_python_json_dumps() {
    assert_eq!(
        dumps_fields(&[
            ("allowed", json!(false)),
            (
                "violations",
                json!([{"where": "m", "line": 3, "name": "Zo\u{eb}"}])
            )
        ]),
        "{\"allowed\": false, \"violations\": [{\"line\": 3, \"name\": \"Zo\\u00eb\", \"where\": \"m\"}]}"
    );
    assert_eq!(
        dumps(&json!("\u{1f600}\t\u{7f}\"\\/")),
        "\"\\ud83d\\ude00\\t\\u007f\\\"\\\\/\""
    );
}

#[test]
fn python_line_splitting_and_truthiness() {
    assert_eq!(
        py::splitlines("a\r\nb\rc\nd\u{2028}e\u{85}f\n"),
        ["a", "b", "c", "d", "e", "f"]
    );
    assert_eq!(py::splitlines("a\n\nb"), ["a", "", "b"]);
    assert!(py::splitlines("").is_empty());
    assert_eq!(py::strip("\u{1c} x \u{a0}"), "x");
    for falsy in [
        json!(null),
        json!(false),
        json!(0),
        json!(0.0),
        json!(""),
        json!([]),
        json!({}),
    ] {
        assert!(!py::truthy(Some(&falsy)), "{falsy}");
    }
    assert!(py::eq(&json!(true), &json!(1.0)) && !py::eq(&json!("1"), &json!(1)));
}

#[test]
fn no_ai_coauthors_needs_configured_trailers_and_patterns() {
    let refused = |commits: Value| {
        matches!(
            valid_message("Fix\n", &map(&json!({ "commits": commits }))),
            Err(Error::Malformed(_))
        )
    };
    assert!(refused(json!({"no_ai_coauthors": true})));
    assert!(refused(
        json!({"no_ai_coauthors": true, "ai_author_patterns": ["bot"]})
    ));
    assert!(refused(
        json!({"no_ai_coauthors": true, "ai_author_trailers": ["Paired-with"]})
    ));
    for trailers in [
        json!([]),
        json!("Paired-with"),
        json!(["Paired with"]),
        json!(["a:b"]),
        json!([7]),
    ] {
        assert!(
            refused(
                json!({"no_ai_coauthors": true, "ai_author_patterns": ["bot"], "ai_author_trailers": trailers})
            ),
            "{trailers}"
        );
    }
    let policy = map(
        &json!({"commits": {"no_ai_coauthors": true, "ai_author_patterns": ["bot"], "ai_author_trailers": ["Paired-with", "Helped-by"]}}),
    );
    for message in ["x\nPAIRED-WITH: a bot", "x\nhelped-by:BOT"] {
        assert_eq!(
            valid_message(message, &policy),
            Err(Error::Policy(
                "AI co-author trailers are disabled by owner policy".into()
            )),
            "{message}"
        );
    }
    assert_eq!(valid_message("x\nReviewed-by: a bot", &policy), Ok(()));
}

fn author_list(file: &Value) -> (Vec<u8>, String) {
    let bytes = serde_json::to_vec(file).expect("list");
    let digest = sha2::Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    (bytes, digest)
}

#[test]
fn a_pinned_author_list_supplies_what_the_policy_leaves_out() {
    use super::AuthorList;
    let (bytes, pin) = author_list(
        &json!({"schema": 1, "trailers": ["Paired-with"], "patterns": ["helper", "\\[bot\\]"]}),
    );
    let list = AuthorList::from_bytes(&bytes, &pin).expect("valid list");
    let rendered = format!("{list:?}");
    assert!(
        rendered.contains(&pin) && !rendered.contains("helper") && !rendered.contains("Paired")
    );
    let mut policy = map(&json!({"commits": {"no_ai_coauthors": true}}));
    list.apply(&mut policy).expect("apply");
    assert_eq!(
        valid_message("x\nPaired-with: Helper <a@b>", &policy),
        Err(Error::Policy(
            "AI co-author trailers are disabled by owner policy".into()
        ))
    );
    assert_eq!(valid_message("x\nPaired-with: Jane <a@b>", &policy), Ok(()));
    let mut own =
        map(&json!({"commits": {"no_ai_coauthors": true, "ai_author_patterns": ["jane"]}}));
    list.apply(&mut own).expect("apply");
    assert_eq!(
        own["commits"]["ai_author_patterns"],
        json!(["jane"]),
        "the policy keeps precedence"
    );
    let mut bare = Map::new();
    list.apply(&mut bare).expect("apply");
    assert!(bare["commits"]["ai_author_trailers"].is_array());
    assert!(list.apply(&mut map(&json!({"commits": 1}))).is_err());
}

#[test]
fn author_list_problems_fail_closed_without_entries() {
    use super::AuthorList;
    let good = json!({"schema": 1, "trailers": ["Paired-with"], "patterns": ["helper"]});
    let (bytes, pin) = author_list(&good);
    for bad_pin in ["0".repeat(64), "abc".into(), pin.to_uppercase()] {
        assert!(
            matches!(
                AuthorList::from_bytes(&bytes, &bad_pin),
                Err(Error::Malformed(_))
            ),
            "{bad_pin}"
        );
    }
    let mut cases = vec![
        json!([1]),
        json!({"schema": 2, "trailers": ["a"], "patterns": ["b"]}),
    ];
    for (field, value) in [
        ("extra", json!(1)),
        ("trailers", json!([])),
        ("trailers", json!(["has space"])),
        ("patterns", json!([""])),
        ("patterns", json!("helper")),
    ] {
        let mut file = good.clone();
        file[field] = value;
        cases.push(file);
    }
    for file in cases {
        let (bytes, pin) = author_list(&file);
        let error = AuthorList::from_bytes(&bytes, &pin).expect_err("refused");
        assert!(!error.to_string().contains("helper"), "{file}");
    }
    assert!(AuthorList::load(std::path::Path::new("/nonexistent/authors.json"), &pin).is_err());
}

#[test]
fn the_documented_example_policy_is_usable() {
    let example: Value = serde_json::from_str(include_str!(
        "../../../examples/standing-policy.example.json"
    ))
    .expect("example policy");
    let policy = map(&example);
    assert_eq!(
        valid_message("Fix\n\nSigned-off-by: J <j@x>\n", &policy),
        Ok(())
    );
    assert_eq!(
        valid_message(
            "Fix\n\nYOUR-TRAILER-KEY: YOUR_AUTHOR_PATTERN\nSigned-off-by: J <j@x>\n",
            &policy
        ),
        Err(Error::Policy(
            "AI co-author trailers are disabled by owner policy".into()
        ))
    );
}
