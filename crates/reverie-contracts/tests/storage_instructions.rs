use reverie_contracts::worker_storage::{InstructionDataError, storage_instruction_bytes};
#[test]
fn managed_block_bytes_match_actual_owned_python_publications() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/storage-instructions-python.json")).unwrap();
    for case in corpus["cases"].as_array().unwrap() {
        let raw = case["input"].as_str().unwrap_or("").as_bytes();
        let result = storage_instruction_bytes(raw);
        if let Some(expected) = case["output"].as_str() {
            assert_eq!(result.unwrap(), expected.as_bytes(), "{}", case["name"])
        } else {
            assert_eq!(
                result,
                Err(InstructionDataError::Ambiguous),
                "{}",
                case["name"]
            )
        }
    }
    assert!(storage_instruction_bytes(&vec![b'x'; 65536]).unwrap().len() > 65536);
    assert_eq!(
        storage_instruction_bytes(&vec![b'x'; 65537]),
        Err(InstructionDataError::Bound)
    );
    assert_eq!(
        storage_instruction_bytes(b"\xff"),
        Err(InstructionDataError::Utf8)
    );
}
