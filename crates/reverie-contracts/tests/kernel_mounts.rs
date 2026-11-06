use reverie_contracts::kernel_mounts::MountTable;
use serde::Deserialize;

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
