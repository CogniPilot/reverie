use super::*;
use serde_json::json;

#[test]
fn mount_points_decode_kernel_escapes_without_requiring_lineage() {
    let raw = br#"12 3 0:1 /overlay/../root /public/bind\040space rw - overlay overlay rw
13 12 0:1 / /public/slash\134name rw - tmpfs tmpfs rw
"#;
    let points = visible_mount_points(raw).unwrap();
    let names: Vec<_> = points
        .iter()
        .map(|point| native::python_path(&point.codepoints()).unwrap())
        .collect();
    assert_eq!(
        names,
        [
            Path::new("/public/bind space"),
            Path::new(r"/public/slash\name")
        ]
    );
    assert!(visible_mount_points(b"bad table").is_err());
}

fn observed_bind(source: &str, running: bool, writable: bool) -> Vec<u8> {
    serde_json::to_vec(&json!([{
        "Mounts": [{"Type": "bind", "Source": source, "RW": writable}],
        "State": {"Running": running},
    }]))
    .unwrap()
}

#[test]
fn native_plan_refuses_physical_store_and_control_aliases() {
    let observe = |path: &Path| {
        Ok(match path.to_str() {
            Some("/rv-test/nix" | "/rv-test/store-alias") => Some((4, 12)),
            Some("/rv-test/control" | "/rv-test/control-alias") => Some((4, 19)),
            _ => None,
        })
    };
    let view = Mounts {
        points: vec![],
        inode: &observe,
    };
    let controls = [PathBuf::from("/rv-test/control/capacity.json")];
    let stores = [
        PathBuf::from("/rv-test/nix"),
        PathBuf::from("/rv-test/home"),
    ];
    let evaluate = |source, running, writes| {
        view.plan(
            &controls,
            &stores,
            &[],
            &observed_bind(source, running, writes),
        )
    };
    assert_eq!(
        evaluate("/rv-test/store-alias", true, true)
            .unwrap_err()
            .to_string(),
        "another running container owns employee data"
    );
    assert!(evaluate("/rv-test/store-alias", false, true).is_ok());
    assert!(evaluate("/rv-test/store-alias", true, false).is_ok());
    assert_eq!(
        evaluate("/rv-test/control-alias", false, false)
            .unwrap_err()
            .to_string(),
        "maintenance control is exposed through a container bind"
    );
}

#[test]
fn a_nested_host_mount_exposes_controls_through_a_future_bind() {
    let observe = |path: &Path| {
        Ok(match path.to_str() {
            Some("/rv-test/private" | "/rv-test/public/nested") => Some((4, 8)),
            _ => None,
        })
    };
    let view = Mounts {
        points: vec!["/rv-test/public/nested".into()],
        inode: &observe,
    };
    let controls = [PathBuf::from("/rv-test/private/future-target.json")];
    let stores = [
        PathBuf::from("/rv-test/nix"),
        PathBuf::from("/rv-test/home"),
    ];
    let future = [PathBuf::from("/rv-test/public")];
    assert_eq!(
        view.plan(&controls, &stores, &future, b"[]")
            .unwrap_err()
            .to_string(),
        "maintenance control is exposed through a container bind"
    );
}
