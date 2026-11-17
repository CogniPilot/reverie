use reverie_contracts::kernel_mounts::MountTable;
use serde::Deserialize;

#[test]
fn filesystem_kind_is_retained_as_data_without_changing_coordinates() {
    let raw = "24 1 0:22 /scope /target rw - cgroup2 cgroup2 rw\n25 1 8:1 / /data rw - ext4 /dev/disk rw\n";
    let table = MountTable::parse(&raw.chars().map(u32::from).collect::<Vec<_>>()).unwrap();
    assert!(table.rows()[0].filesystem_is("cgroup2"));
    assert!(!table.rows()[0].filesystem_is("ext4"));
    assert!(table.rows()[1].filesystem_is("ext4"));
    assert!(!table.rows()[1].filesystem_is("cgroup2"));
    assert_eq!(table.rows()[0].id().as_str(), "24");
    assert_eq!(table.rows()[0].parent_id().unwrap().as_str(), "1");
    assert_eq!(
        table.rows()[0].root().unwrap().codepoints(),
        "/scope".chars().map(u32::from).collect::<Vec<_>>()
    );
}

#[derive(Debug, Deserialize, Eq, PartialEq)]
struct Row {
    id: String,
    major: String,
    minor: String,
    root: Option<Vec<u32>>,
    point: Vec<u32>,
}
#[derive(Deserialize)]
struct Case {
    name: String,
    points: Vec<u32>,
    rows: Option<Vec<Row>>,
}
#[test]
fn actual_python_namespace_rows_preserve_coordinates_and_unknown_roots() {
    let cases: Vec<Case> = serde_json::from_str(include_str!(
        "fixtures/reservation-engine/mount-python.json"
    ))
    .unwrap();
    assert_eq!(cases.len(), 18);
    for case in cases {
        let rows = MountTable::parse(&case.points).ok().map(|table| {
            table
                .rows()
                .iter()
                .map(|row| Row {
                    id: row.id().as_str().to_owned(),
                    major: row.device().major().as_str().to_owned(),
                    minor: row.device().minor().as_str().to_owned(),
                    root: row.root().map(|path| path.codepoints().to_vec()),
                    point: row.point().codepoints().to_vec(),
                })
                .collect()
        });
        assert_eq!(rows, case.rows, "{}", case.name);
    }
}
