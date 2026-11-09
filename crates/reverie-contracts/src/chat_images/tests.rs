use super::*;
use reverie_core::{chat_images::ImageFileName, decimal::UnsignedInteger};
use serde_json::{Value as Json, json};
mod inspection;
const SID: &str = "11111111-1111-4111-8111-111111111111";
const RID: &str = "33333333-3333-4333-8333-333333333333";
const MID: &str = "44444444-4444-4444-8444-444444444444";
const FID: &str = "55555555-5555-4555-8555-555555555555";
fn scope() -> Json {
    json!({"version":1,"sessionId":SID,"roomId":RID,"messageId":MID,"generation":"a".repeat(64),"fileIds":[FID]})
}
fn raw(value: &Json) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}
#[test]
fn closed_wire_and_scope_keep_source_types_errors_and_duplicate_refusal() {
    let value = json!({"purpose":PURPOSE,"action":"binding","sessionId":SID});
    assert!(matches!(
        decode_request(&raw(&value)).unwrap(),
        ImageRequest::Binding(_)
    ));
    let value = json!({"purpose":PURPOSE,"action":"materialize","sessionId":SID,"request":scope()});
    assert!(matches!(
        decode_request(&raw(&value)).unwrap(),
        ImageRequest::Materialize(_)
    ));
    for field in ["path", "url", "command"] {
        let mut changed = value.clone();
        changed[field] = json!("forbidden");
        assert_eq!(
            decode_request(&raw(&changed)).err().unwrap().code(),
            "invalid_request"
        );
    }
    assert!(decode_request(format!("{{\"purpose\":\"{PURPOSE}\",\"action\":\"binding\",\"sessionId\":\"{SID}\",\"sessionId\":\"{SID}\"}}").as_bytes()).is_err());
    for version in [json!(true), json!(1.0), json!("1"), json!(0)] {
        let mut changed = scope();
        changed["version"] = version;
        assert_eq!(
            decode_scope(&raw(&changed)).err().unwrap().code(),
            "invalid_request"
        );
    }
    let mut changed = scope();
    changed.as_object_mut().unwrap().remove("roomId");
    changed["extra"] = json!(1);
    assert_eq!(
        decode_scope(&raw(&changed)).err().unwrap().code(),
        "invalid_request"
    );
    let mut changed = scope();
    changed["fileIds"] = json!([FID, FID]);
    assert_eq!(
        decode_scope(&raw(&changed)).err().unwrap().code(),
        "invalid_files"
    );
}
#[test]
fn bytes_json_encoding_and_limits_are_before_purpose_validation() {
    let value =
        format!("{{\"purpose\":\"{PURPOSE}\",\"action\":\"binding\",\"sessionId\":\"{SID}\"}}");
    let mut utf16 = vec![0xff, 0xfe];
    for cp in value.encode_utf16() {
        utf16.extend(cp.to_le_bytes());
    }
    assert!(decode_request(&utf16).is_ok());
    assert_eq!(
        decode_request(&vec![b' '; 4097]).err().unwrap().code(),
        "invalid_request"
    );
    let mut request = scope();
    request["sessionId"] = json!("00000000-0000-0000-0000-000000000000");
    assert!(decode_scope(&raw(&request)).is_ok());
}
#[test]
fn membership_requires_exact_message_single_reference_and_raster_mime() {
    let scope = decode_scope(&raw(&scope())).unwrap();
    let file = scope.files()[0].clone();
    let message = json!({"success":true,"data":{"message":{"id":MID,"attachments":[{"id":FID,"type":"image/png"}]}}});
    assert_eq!(
        message_file(&raw(&message), &scope, &file).unwrap(),
        Raster::Png
    );
    for changed in [
        json!({"success":false}),
        json!({"success":true,"data":{"message":{"id":MID,"deleted":1,"attachments":[]}}}),
    ] {
        assert_eq!(
            message_file(&raw(&changed), &scope, &file)
                .err()
                .unwrap()
                .code(),
            "message_or_file_refused"
        );
    }
    let mut changed = message;
    changed["data"]["message"]["attachments"] =
        json!([{"id":FID,"type":"image/png"},{"id":FID,"type":"image/png"}]);
    assert!(message_file(&raw(&changed), &scope, &file).is_err());
}
#[test]
fn ledger_preserves_arbitrary_nonnegative_inode_numbers_and_canonical_bytes() {
    let big = "9".repeat(200);
    let raw = format!("{{\"cache\":[{big},2],\"entries\":[],\"version\":1}}");
    let ledger = decode_ledger(raw.as_bytes()).unwrap();
    assert!(!ledger.cache_matches([1, 2]));
    assert_eq!(encode_ledger(&ledger), raw.as_bytes());
    let name = ImageFileName::parse(&format!("{FID}.png")).unwrap();
    let entry = LedgerEntry::try_new(
        name,
        [UnsignedInteger::from_u64(1), UnsignedInteger::from_u64(2)],
        8,
        image_digest(b"12345678"),
    )
    .unwrap();
    let ledger = ImageLedger::try_new(
        [UnsignedInteger::from_u64(3), UnsignedInteger::from_u64(4)],
        vec![entry],
    )
    .unwrap();
    let round = decode_ledger(&encode_ledger(&ledger)).unwrap();
    assert!(round.cache_matches([3, 4]));
    assert!(round.entries()[0].inode_matches([1, 2]));
    assert!(decode_ledger(br#"{"version":true,"cache":[1,2],"entries":[]}"#).is_err());
    assert!(decode_ledger(br#"{"version":1,"cache":[-1,2],"entries":[]}"#).is_err());
}
#[test]
fn raster_and_ready_never_infer_format_or_path_from_request_names() {
    for (bytes, kind) in [
        (b"\x89PNG\r\n\x1a\n".as_slice(), Raster::Png),
        (b"\xff\xd8\xff".as_slice(), Raster::Jpeg),
        (b"GIF89a".as_slice(), Raster::Gif),
        (b"RIFFxxxxWEBP".as_slice(), Raster::Webp),
    ] {
        assert_eq!(image_format(bytes).unwrap(), kind);
    }
    assert_eq!(
        image_format(b"<svg/>").err().unwrap().code(),
        "unsupported_image"
    );
    let scope = decode_scope(&raw(&scope())).unwrap();
    let name = ImageFileName::parse(&format!("{FID}.png")).unwrap();
    let image = ReadyImage::try_new(scope.files()[0].clone(), name, 8, 1800).unwrap();
    let output: Json = serde_json::from_slice(&ready_response(&scope, &[image]).unwrap()).unwrap();
    assert_eq!(
        output["files"][0]["path"],
        format!("/tmp/.reverie-chat-images/{FID}.png")
    );
}
