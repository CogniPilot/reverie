use reverie_contracts::worker_launch::{TerminalFrame, decode_terminal_frame, viewer_clients};
use serde_json::Value;
fn corpus() -> Value {
    serde_json::from_str(include_str!("fixtures/worker-terminal-python.json")).unwrap()
}
#[test]
fn unchanged_python_resize_client_fullmatch_and_splitlines_recipes() {
    let corpus = corpus();
    for case in corpus["clients"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        let actual = viewer_clients(text).map(|rows| {
            rows.into_iter()
                .map(|row| {
                    let (cols, rows) = row.dimensions();
                    vec![row.guest_process_id(), u64::from(cols), u64::from(rows)]
                })
                .collect::<Vec<_>>()
        });
        let expected: Option<Vec<Vec<u64>>> =
            serde_json::from_value(case["value"].clone()).unwrap();
        assert_eq!(actual, expected, "{text:?}");
    }
}
#[test]
fn actual_python_resize_json_types_unpack_order_dimensions_and_bytes_encodings() {
    let corpus = corpus();
    for case in corpus["resize"].as_array().unwrap() {
        let hex = case["hex"].as_str().unwrap();
        let bytes = (0..hex.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap())
            .collect::<Vec<_>>();
        match decode_terminal_frame(b'R', &bytes) {
            Ok(TerminalFrame::Resize(size)) => assert_eq!(
                vec![size.cols(), size.rows()],
                serde_json::from_value::<Vec<u16>>(case["size"].clone()).unwrap()
            ),
            Ok(TerminalFrame::Input(_)) => panic!("R is resize"),
            Err(error) => assert_eq!(error.to_string(), case["error"].as_str().unwrap(), "{hex}"),
        }
    }
}
#[test]
fn input_borrows_arbitrary_bytes_and_unknown_kind_does_not_parse_json() {
    let input = [0, 255, 27, b'R'];
    let TerminalFrame::Input(bytes) = decode_terminal_frame(b'I', &input).unwrap() else {
        panic!("input")
    };
    assert!(std::ptr::eq(bytes.as_ptr(), input.as_ptr()));
    assert_eq!(bytes, input);
    assert_eq!(
        decode_terminal_frame(b'X', b"invalid JSON")
            .err()
            .unwrap()
            .to_string(),
        "Invalid terminal frame"
    );
}
