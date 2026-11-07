use reverie_contracts::worker_launch::{ExitReceiptDecoder, ExitReceiptError};
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
#[test]
fn actual_read_text_then_int_receipts_preserve_utf8_precedence_and_decimal_rules_in_every_chunking()
{
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/worker-exit-receipt-python.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let hex = case["hex"].as_str().unwrap();
        let bytes = (0..hex.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap())
            .collect::<Vec<_>>();
        for size in [1, 2, 3, 4, 7, 1024, 65536] {
            let mut decoder = ExitReceiptDecoder::new();
            for chunk in bytes.chunks(size) {
                decoder.push(chunk);
            }
            match decoder.finish() {
                Ok(output) => assert_eq!(
                    output
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>(),
                    case["output"].as_str().unwrap()
                ),
                Err(error) => {
                    let error = match error {
                        ExitReceiptError::Utf8 => "utf8",
                        ExitReceiptError::Integer => "integer",
                        ExitReceiptError::Digits => "digits",
                    };
                    assert_eq!(
                        error,
                        case["error"].as_str().unwrap(),
                        "chunk={size}, input prefix={:?}",
                        &bytes[..bytes.len().min(32)]
                    );
                }
            }
        }
    }
}
