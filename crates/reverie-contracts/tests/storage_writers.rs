use reverie_contracts::{
    reservation_engine::{ReservationConfiguration, StorageIdentityRef},
    storage_identity::decode_metadata,
    storage_writers::*,
    worker_config,
};
use reverie_core::{
    ids::{ProfileEmployeeId, ProfileSessionId},
    posix_path::PosixPath,
};
use serde_json::Value;
fn expected_error(case: &Value) -> WriterDataError {
    match case["error"].as_str().unwrap() {
        "TypeError" | "AttributeError" | "KeyError" => WriterDataError::Structure,
        "JSONDecodeError" | "ValueError" => WriterDataError::Json,
        "RuntimeError" => {
            let message = case["message"].as_str().unwrap();
            if message.starts_with("Cannot establish") {
                WriterDataError::Ids
            } else if message.contains("inventory changed") {
                WriterDataError::Inventory
            } else if message.contains("state changed") {
                WriterDataError::State
            } else if message.starts_with("Employee laptop") {
                WriterDataError::CanonicalStorage
            } else if message.starts_with("Another running") {
                WriterDataError::CompetingWriter
            } else {
                panic!("unmapped actual source error: {message}")
            }
        }
        other => panic!("unexpected source class {other}"),
    }
}
fn resolved_rows(
    rows: &WriterInventory,
    selection: WriterSelection<'_>,
    home: &str,
) -> Result<(), WriterDataError> {
    for index in 0..rows.len() {
        let row = rows.row(index, selection)?;
        for mount in row.mounts() {
            let source = mount.source()?.scalar_text().expect("scalar oracle paths");
            // Independent resolved DATA for the Python corpus's owned alias;
            // actual filesystem resolution is qualified separately by Host.
            let resolved = PosixPath::from_scalar_text(&source.replace("/owned/home-alias", home));
            mount.check_resolved(&resolved)?;
        }
    }
    Ok(())
}
#[test]
fn independent_actual_python_writer_data_phases_match_before_host_resolution() {
    let corpus: Value =
        serde_json::from_str(include_str!("fixtures/storage-writers-python.json")).unwrap();
    let session = ProfileSessionId::parse(corpus["session"].as_str().unwrap()).unwrap();
    let employee = ProfileEmployeeId::parse(corpus["employee"].as_str().unwrap()).unwrap();
    let config = ReservationConfiguration::capture(
        worker_config::decode(br#"{"stateRoot":"/owned/state","scratchRoot":"/owned/scratch"}"#)
            .unwrap(),
    );
    let paths = config
        .storage_text(StorageIdentityRef::Employee(&employee))
        .unwrap();
    let scalar = |path: &PosixPath| {
        path.codepoints()
            .into_iter()
            .map(|point| char::from_u32(point).unwrap())
            .collect::<String>()
    };
    let home = scalar(paths.home());
    let nix = scalar(paths.nix());
    let parent = scalar(&paths.home().parent());
    for case in corpus["cases"].as_array().unwrap() {
        let mut calls = 1;
        let result = (|| {
            let ids = WriterIds::decode(case["listed"].as_str().unwrap())?;
            if ids.is_empty() {
                return Ok(());
            }
            calls += 1;
            let raw = case["inspect"]
                .as_str()
                .unwrap()
                .replace("@HOME@", &home)
                .replace("@NIX@", &nix)
                .replace("@PARENT@", &parent)
                .replace("@OUT@", "/owned/outside")
                .replace("@ALIAS@", "/owned/home-alias");
            let rows = WriterInventory::decode(raw.as_bytes(), &ids)?;
            resolved_rows(
                &rows,
                WriterSelection {
                    deployment: "fixture",
                    session: &session,
                    identity: employee.as_str(),
                    paths: &paths,
                },
                &home,
            )?;
            Ok(())
        })();
        if case["accepted"].as_bool().unwrap() {
            assert_eq!(result, Ok(()), "{}", case["name"])
        } else {
            assert_eq!(result, Err(expected_error(case)), "{}", case["name"])
        }
        assert_eq!(
            calls,
            case["calls"].as_array().unwrap().len(),
            "{} phase count",
            case["name"]
        );
    }
}
#[test]
fn actual_wait_bindings_preserve_selected_values_default_spacing_and_late_shape_rules() {
    let corpus: Value =
        serde_json::from_str(include_str!("fixtures/launch-wait-binding-python.json")).unwrap();
    let session = ProfileSessionId::parse(corpus["session"].as_str().unwrap()).unwrap();
    for case in corpus["cases"].as_array().unwrap() {
        let raw = case["raw"].as_str().unwrap();
        let bytes = if case["encoding"] == "utf-16" {
            let mut bytes = vec![0xff, 0xfe];
            for word in raw.encode_utf16() {
                bytes.extend_from_slice(&word.to_le_bytes())
            }
            bytes
        } else {
            raw.as_bytes().to_vec()
        };
        let metadata = decode_metadata(&bytes);
        if case.get("error").is_some() {
            match metadata {
                Ok(metadata) => {
                    let expected = match case["error"].as_str().unwrap() {
                        "AttributeError" | "TypeError" => WriterDataError::Structure,
                        "ValueError" => WriterDataError::WaitBinding,
                        other => panic!("unexpected decoded source error {other}"),
                    };
                    assert_eq!(
                        launch_wait_binding(&metadata, &session).err(),
                        Some(expected),
                        "{}",
                        case["name"]
                    );
                }
                Err(_) => assert!(
                    matches!(
                        case["error"].as_str(),
                        Some("ValueError" | "JSONDecodeError")
                    ),
                    "{} unexpected metadata refusal",
                    case["name"]
                ),
            }
        } else {
            let result = launch_wait_binding(&metadata.unwrap(), &session).unwrap();
            assert_eq!(
                result.as_ref().map(|binding| binding.bytes()),
                case["binding"].as_str().map(str::as_bytes),
                "{}",
                case["name"]
            );
        }
    }
}
