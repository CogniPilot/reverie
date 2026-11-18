use super::*;

fn container(id: char, name: &str, state: &str, mounts: Value) -> Value {
    json!({
        "Id": id.to_string().repeat(64),
        "Names": [format!("/{name}")],
        "State": state,
        "Mounts": mounts,
    })
}

#[test]
fn office_and_worker_writers_must_be_quiescent_even_for_read_only_binds() {
    let root = std::env::temp_dir().canonicalize().unwrap();
    let mut nonce = [0u8; 16];
    getrandom::getrandom(&mut nonce).unwrap();
    let scratch = root.join(format!(
        "scratch-writers-{:032x}",
        u128::from_ne_bytes(nonce)
    ));
    fs::create_dir_all(scratch.join("laptops")).unwrap();
    let selection = Selection::from_office(&container(
        'a',
        "office",
        "running",
        json!([
            { "Type": "bind", "Destination": "/scratch", "Source": scratch, "RW": true }
        ]),
    ))
    .unwrap();
    let rows = [
        container('a', "office", "running", json!([])),
        container(
            'b',
            "worker",
            "paused",
            json!([
                { "Type": "bind", "Source": scratch, "RW": false }
            ]),
        ),
        container(
            'c',
            "irrelevant",
            "running",
            json!([
                { "Type": "tmpfs" }
            ]),
        ),
    ];
    assert_eq!(
        blockers(&selection, &json!(rows)).unwrap(),
        ["office", "worker"]
    );
    assert!(
        blockers(
            &selection,
            &json!([
                container('a', "office", "exited", json!([])),
                container('b', "worker", "exited", json!([])),
            ])
        )
        .unwrap()
        .is_empty()
    );
    assert!(blockers(&selection, &json!([&rows[1]])).is_err());
    fs::remove_dir_all(scratch).unwrap();
}
