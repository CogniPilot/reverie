use reverie_core::worker_wire::{HEADER_BYTES, MAX_FRAME, WorkerFrameHeader};
#[test]
fn actual_python_send_frame_headers_preserve_bytes_and_common_bound() {
    let rows: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/worker-wire-python.json")).unwrap();
    for row in rows.as_array().unwrap() {
        let kind = u8::try_from(row["kind"].as_u64().unwrap()).unwrap();
        let length = usize::try_from(row["length"].as_u64().unwrap()).unwrap();
        let actual = WorkerFrameHeader::for_payload(kind, length);
        if row["header"].is_null() {
            assert!(actual.is_none());
            continue;
        }
        let bytes: [u8; HEADER_BYTES] = serde_json::from_value(row["header"].clone()).unwrap();
        assert_eq!(actual.unwrap().encode(), bytes);
        let decoded = WorkerFrameHeader::decode(bytes);
        assert_eq!(decoded.kind(), kind);
        assert_eq!(usize::try_from(decoded.payload_length()).unwrap(), length);
    }
    let raw = WorkerFrameHeader::decode([b'T', 255, 255, 255, 255]);
    assert_eq!(raw.payload_length(), u32::MAX);
    assert!(
        usize::try_from(raw.payload_length()).unwrap() > MAX_FRAME,
        "raw syntax is not an incoming-purpose validation receipt"
    );
}
