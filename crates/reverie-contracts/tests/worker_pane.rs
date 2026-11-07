//! Actual original Python command projection, with the native supervisor delta explicit.
use reverie_core::ids::ProfileSessionId;
#[test]
fn original_python_tmux_vectors_preserve_all_words_except_the_native_supervisor() {
    use reverie_core::{
        ids::NativeOperationId,
        worker_launch::{ContainerReference, TerminalSize, WorkerName},
    };
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/worker-pane-python.json")).unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 3);
    for case in cases {
        let session = ProfileSessionId::parse(case["session"].as_str().unwrap()).unwrap();
        let name = WorkerName::for_session("fixture", &session).unwrap();
        let nonce = NativeOperationId::parse(case["nonce"].as_str().unwrap()).unwrap();
        let terminal = TerminalSize::try_new(
            case["cols"].as_u64().unwrap().try_into().unwrap(),
            case["rows"].as_u64().unwrap().try_into().unwrap(),
        )
        .unwrap();
        let strings = |v: &serde_json::Value| {
            v.as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        let mut expected = strings(&case["originalStart"]);
        let shell = expected.iter().position(|s| s == "/bin/bash").unwrap();
        assert_eq!(&expected[shell..shell + 2], &["/bin/bash", "-c"]);
        assert!(expected[shell + 2].starts_with("/bin/reverie-worker-child \"$1\"; result=$?;"));
        assert_eq!(expected[shell + 3], "laptop");
        let record = expected[shell + 4].clone();
        let exit = expected[shell + 5].clone();
        expected.splice(
            shell..shell + 6,
            [
                "/bin/reverie-worker-child".to_owned(),
                "--pane-exit".to_owned(),
                exit,
                record,
            ],
        );
        let scalar = |args: Vec<reverie_contracts::storage_identity::MetadataText>| {
            args.into_iter()
                .map(|arg| arg.scalar_text().unwrap())
                .collect::<Vec<_>>()
        };
        let reference = ContainerReference::Worker(&name);
        assert_eq!(
            scalar(reverie_contracts::worker_launch::pane_start_arguments(
                &reference, &nonce, terminal
            )),
            expected
        );
        assert_eq!(
            scalar(reverie_contracts::worker_launch::pane_status_arguments(
                &reference
            )),
            strings(&case["originalStatus"])
        );
    }
}
