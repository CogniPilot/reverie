use super::*;
use reverie_contracts::worker_validation::WorkerValidationData;
fn setup(tree: &Tree, recipe: &str) {
    fs::remove_file(tree.root.join("state/resource-reservation-control.json")).unwrap();
    match recipe {
        "marker-file" | "normalized-marker" => {
            tree.write("state/resource-reservation-control.json", b"retained fence")
        }
        "marker-directory" => {
            let path = tree.root.join("state/resource-reservation-control.json");
            fs::create_dir(&path).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        "marker-dangling" => symlink(
            tree.root.join("absent"),
            tree.root.join("state/resource-reservation-control.json"),
        )
        .unwrap(),
        "pending-file" => tree.write(
            "state/resource-reservation-control.pending",
            b"retained pending",
        ),
        "pending-dangling" => symlink(
            tree.root.join("absent"),
            tree.root.join("state/resource-reservation-control.pending"),
        )
        .unwrap(),
        "inaccessible-state" => {
            fs::create_dir(tree.root.join("closed")).unwrap();
            fs::create_dir(tree.root.join("closed/state")).unwrap();
            tree.write(
                "closed/state/resource-reservation-control.json",
                b"hidden fence",
            );
            tree.mode("closed", 0);
        }
        "missing-state" | "clean" | "unencodable-state" | "nul-state" | "option-no-state"
        | "null-state" => {}
        other => panic!("unknown source recipe {other}"),
    }
}
#[test]
fn actual_configured_recipes_preserve_optional_short_circuit_lexists_and_path_data_semantics() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/optional-control-python.json"
    ))
    .unwrap();
    assert_eq!(corpus["cases"].as_array().unwrap().len(), 13);
    for case in corpus["cases"].as_array().unwrap() {
        if case["requiresUnprivileged"] == true && native::uid() == 0 {
            continue;
        }
        let tree = Tree::new();
        let recipe = case["recipe"].as_str().unwrap();
        setup(&tree, recipe);
        let data = worker_config::decode(
            case["configText"]
                .as_str()
                .unwrap()
                .replace("$ROOT", tree.root.to_str().unwrap())
                .as_bytes(),
        )
        .unwrap();
        let option = WorkerValidationData::new(&data).reservation().unwrap();
        let config = ReservationConfiguration::capture(data);
        let result = if option.is_some() {
            Ok(true)
        } else {
            prior_control_present(&config)
        };
        if recipe == "inaccessible-state" {
            tree.mode("closed", 0o700);
        }
        if case.get("error").is_some() {
            assert!(result.is_err(), "{recipe}");
        } else {
            assert_eq!(
                result.unwrap(),
                case["configured"].as_bool().unwrap(),
                "{recipe}"
            );
        }
    }
}
