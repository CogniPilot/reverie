use super::*;

fn configured() -> WebPolicy {
    WebPolicy {
        search: true,
        fetch: true,
        max_calls: 1,
        result_chars: 90,
    }
}

fn settlement(phase: Phase, output: Value) -> Settlement {
    Settlement {
        phase,
        web: configured(),
        searches: 0,
        journal_names: vec!["journal_recall".to_owned()],
        output,
    }
}

fn decision(state: &Settlement) -> Value {
    let step = ModelStep::read(&state.output);
    serde_json::to_value(state.decide(&step)).unwrap()
}

fn call(name: &str, arguments: Value) -> Value {
    json!({"id": "id", "function": {"name": name, "arguments": arguments}})
}

#[test]
fn offered_tools_follow_remaining_budgets_and_preserve_finish_notes() {
    let plan = Planning {
        stage: Stage::Explore,
        web: configured(),
        searches: 0,
        journal_available: true,
        journal_tools: vec![json!({"function": {"name": "journal_recall"}})],
        task_tools: Some(vec![json!({"function": {"name": "run_workspace_task"}})]),
    }
    .choose();
    assert!(plan.phase == Phase::Tools);
    assert_eq!(
        plan.tools
            .unwrap()
            .iter()
            .map(|tool| tool["function"]["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "web_search",
            "web_fetch",
            "journal_recall",
            "run_workspace_task"
        ]
    );
    let plan = Planning {
        stage: Stage::Explore,
        web: configured(),
        searches: 1,
        journal_available: true,
        journal_tools: vec![],
        task_tools: None,
    }
    .choose();
    assert!(plan.phase == Phase::Finish);
    assert_eq!(plan.note, Some(JOURNAL_NOTE));
    assert!(plan.tools.is_none() && !plan.replace_note);
    let plan = Planning {
        stage: Stage::Retry,
        web: configured(),
        searches: 1,
        journal_available: true,
        journal_tools: vec![],
        task_tools: None,
    }
    .choose();
    assert!(plan.phase == Phase::Retry);
    assert_eq!(plan.note, Some(RETRY_NOTE));
    assert!(plan.tools.is_none() && plan.replace_note);
}

#[test]
fn only_first_admitted_tool_runs_and_invalid_web_calls_spend_the_same_budget() {
    let output = json!({"tool_calls": [
        call("journal_recall", json!("{}")),
        call("web_search", json!({"query":"discard me"})),
    ]});
    let mut state = settlement(Phase::Tools, output);
    assert_eq!(decision(&state)["action"], "journal");
    state.journal_names.clear();
    let web = decision(&state);
    assert_eq!(web["action"], "web");
    assert_eq!(web["argument"]["kind"], "invalid");
    assert_eq!(web["searches"], 1);
    state.searches = 1;
    assert_eq!(decision(&state)["action"], "finish");
}

#[test]
fn reply_precedence_keeps_limits_and_the_single_retry() {
    for phase in [Phase::Direct, Phase::Tools, Phase::Finish, Phase::Retry] {
        let state = settlement(
            phase,
            json!({"_finish_reason":"length", "content":"visible"}),
        );
        let expected = if phase == Phase::Direct {
            CHAT_LIMIT_LINE
        } else {
            "visible"
        };
        assert_eq!(decision(&state)["reply"], expected);
    }
    let mut state = settlement(Phase::Finish, json!({"content":"<think>private"}));
    assert_eq!(decision(&state)["action"], "retry");
    state.phase = Phase::Retry;
    state.searches = 1;
    let result = decision(&state);
    assert_eq!(result["reply"], format!("{WEB_MARK}{FAIL_LINE}"));
    assert_eq!(
        reply_outcome(result["reply"].as_str().unwrap()),
        "fail_line"
    );
    state.output = json!({"content":"", "_context_overflow":true});
    assert_eq!(
        decision(&state)["reply"],
        format!("{WEB_MARK}{OVERFLOW_LINE}")
    );
}

#[test]
fn output_screening_matches_python_word_boundaries_and_writes_closed_classifications() {
    for (raw, want) in [
        ("", "empty"),
        ("<think>private</think>", "think_only"),
        ("<think>private", "think_unclosed"),
        ("</think>", "unusable"),
        ("<parameter name=x>", "markup"),
        ("<tool_callé", "answer"),
        ("<think>hidden</think>\u{85}visible", "answer"),
        ("{\"name\":\u{85}\"web_search\"}", "markup"),
    ] {
        let output = json!({"content": raw});
        let model = ModelStep::read(&output);
        assert_eq!(model.outcome(), want, "{raw:?}");
    }
}

#[test]
fn validated_web_replay_uses_capped_rebuilt_arguments_and_scoped_target_validation() {
    let invalid = call("web_fetch", json!("{\"url\":\"https://example.com:444/\"}"));
    assert!(matches!(
        Argument::decode(&invalid, configured()),
        Argument::Invalid
    ));
    let also_invalid = call(
        "web_fetch",
        json!({"url":"https://example.com", "extra":"no"}),
    );
    assert!(matches!(
        Argument::decode(&also_invalid, configured()),
        Argument::Invalid
    ));
    let query = call("web_search", json!({"query": " hello\n猫\u{200b} "}));
    let accepted = Argument::decode(&query, configured());
    assert!(matches!(&accepted, Argument::Search(text) if text == "hello猫"));
    let [assistant, tool] =
        web::web_replay(&query, &accepted, &"⚓".repeat(1100), &"x".repeat(150), 90);
    assert_eq!(assistant["content"].as_str().unwrap().chars().count(), 1000);
    assert_eq!(
        assistant["tool_calls"][0]["function"]["arguments"],
        "{\"query\": \"hello猫\"}"
    );
    assert_eq!(tool["tool_call_id"], "id");
    assert!(
        tool["content"]
            .as_str()
            .unwrap()
            .ends_with("omitted content is unknown.]")
    );
    let [assistant, tool] = journal_replay(&query, "{}".into(), "x".repeat(RESULT_CHARS + 1));
    assert_eq!(assistant["tool_calls"][0]["function"]["arguments"], "{}");
    assert!(
        tool["content"]
            .as_str()
            .unwrap()
            .ends_with("result_exceeds_budget\"}")
    );
}
