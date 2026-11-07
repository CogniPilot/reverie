//! Fixed attach recipe measured from unchanged CPython source, every word.
use reverie_core::{
    ids::{ContainerId, ProfileSessionId},
    worker_launch::{ContainerReference, WorkerName},
};
#[test]
fn actual_python_viewer_attach_vectors_preserve_exact_locale_marker_and_tmux_words() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/worker-viewer-python.json")).unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 3);
    let session = ProfileSessionId::parse("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee").unwrap();
    let name = WorkerName::for_session("fixture", &session).unwrap();
    let cid = ContainerId::parse(&"c".repeat(64)).unwrap();
    for case in cases {
        let reference = if case["name"].as_str().unwrap() == name.as_str() {
            ContainerReference::Worker(&name)
        } else {
            assert_eq!(case["name"].as_str().unwrap(), cid.as_str());
            ContainerReference::Observed(&cid)
        };
        let marker: Vec<_> = case["markerBytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| u8::try_from(n.as_u64().unwrap()).unwrap())
            .collect();
        let actual = reverie_contracts::worker_launch::viewer_attach_arguments(
            &reference,
            &marker.try_into().unwrap(),
        )
        .into_iter()
        .map(|word| word.scalar_text().unwrap())
        .collect::<Vec<_>>();
        let expected = case["expected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|word| word.as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(actual, expected);
    }
}
