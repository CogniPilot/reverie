use super::*;
#[test]
fn eighteen_actual_unpatched_python_constructor_filesystem_and_effect_order_recipes() {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../reverie-contracts/tests/fixtures/command-telemetry/native-legacy.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let tree = Tree::new();
        let runtime = tree.runtime();
        let mut raw = tree.raw();
        let name = case["name"].as_str().unwrap();
        let mut listing = String::new();
        let mut inspect = json!([{"Mounts":[]}]);
        match name {
            "disabled" => raw = json!({"commandTelemetry":{"enabled":false}}),
            "uid" => raw["uid"] = json!(native::uid() + 1),
            "public-state" => {
                fs::set_permissions(tree.0.join("state"), fs::Permissions::from_mode(0o755))
                    .unwrap()
            }
            "state-source" => raw["mounts"] = json!([{"source":tree.0.join("state")}]),
            "future-safe" => raw["mounts"] = json!([{"source":tree.0.join("future/deep")}]),
            "alias-safe" => {
                std::os::unix::fs::symlink(tree.0.join("safe"), tree.0.join("alias")).unwrap();
                raw["mounts"] = json!([{"source":tree.0.join("alias")}]);
            }
            "noncanonical" => {
                raw["mounts"] = json!([{"source":format!("{}/safe/.",tree.0.display())}])
            }
            "readonly-ancestor" => raw["mounts"] = json!([{"source":tree.0,"readonly":true}]),
            "scratch-ancestor" => raw["scratchRoot"] = json!(tree.0.join("state")),
            "api-ancestor" => raw["apiSocketRoot"] = json!(tree.0.join("state")),
            "company-sink" => raw["companyRoot"] = json!(tree.sink()),
            "bad-mount" => raw["mounts"] = json!([{}]),
            "bad-inventory" => listing = format!("{}\nBAD", "a".repeat(12)),
            "bad-inspect" => {
                listing = "a".repeat(12);
                inspect = json!([{"Mounts":[null]}]);
            }
            "volume-state" | "tmpfs-state" => {
                listing = "a".repeat(12);
                inspect = json!([{"Mounts":[{"Type":if name=="volume-state"{"volume"}else{"tmpfs"},"Source":tree.0.join("state")}]}]);
            }
            "legacy-name" => fs::create_dir(tree.0.join("state").join("-".repeat(36))).unwrap(),
            "normal" => {}
            _ => panic!("unknown sealed recipe"),
        }
        fs::write(tree.0.join("ps.out"), listing).unwrap();
        fs::write(
            tree.0.join("inspect.out"),
            serde_json::to_vec(&inspect).unwrap(),
        )
        .unwrap();
        let result = CommandTelemetry::capture(&runtime, &config(raw));
        assert_eq!(
            result.is_ok(),
            case["ok"].as_bool().unwrap(),
            "{name}: {}",
            result.err().map_or_else(String::new, |e| format!("{e:?}"))
        );
        assert_eq!(
            tree.sink().exists(),
            case["sink"].as_bool().unwrap(),
            "{name}"
        );
        let trace = fs::read_to_string(tree.0.join("calls.txt")).unwrap_or_default();
        let calls = trace
            .lines()
            .map(|line| line.split('\0').collect::<Vec<_>>())
            .collect::<Vec<_>>();
        assert_eq!(json!(calls), case["calls"], "{name}");
    }
}
