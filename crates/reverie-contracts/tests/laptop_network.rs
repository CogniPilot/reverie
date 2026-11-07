use reverie_contracts::worker_launch::{NetworkDataError, assert_network_labels};
use reverie_core::ids::ProfileSessionId;
#[test]
fn actual_python_network_branch_preserves_default_json_and_label_phases() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/laptop-network-python.json")).unwrap();
    assert_eq!(corpus["cases"].as_array().unwrap().len(), 29);
    let sid = ProfileSessionId::parse(corpus["sessionId"].as_str().unwrap()).unwrap();
    for case in corpus["cases"].as_array().unwrap() {
        let result = assert_network_labels(
            case["stdout"].as_str().unwrap().as_bytes(),
            corpus["deployment"].as_str().unwrap(),
            &sid,
        );
        let expected = match case["result"].as_str().unwrap() {
            "ok" => Ok(()),
            "JSONDecodeError" => Err(NetworkDataError::Json),
            "ValueError" if case["stdout"].as_str().unwrap().contains(&"1".repeat(4301)) => {
                Err(NetworkDataError::Json)
            }
            "ValueError" => Err(NetworkDataError::Ownership),
            "AttributeError" | "IndexError" | "KeyError" | "TypeError" => {
                Err(NetworkDataError::Structure)
            }
            other => panic!("unhandled oracle outcome {other}"),
        };
        assert_eq!(result, expected, "{}", case["stdout"]);
    }
}
