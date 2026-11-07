use reverie_core::python_regex;
use serde_json::Value;
#[test]
fn every_codepoint_matches_frozen_python_class_and_simple_case_oracles() {
    for line in include_str!("fixtures/cpython313-classes-r1.jsonl").lines() {
        let row: Value = serde_json::from_str(line).unwrap();
        let ranges = row["ranges"].as_array().unwrap();
        let mut index = 0;
        for point in 0..=0x10ffff {
            while ranges
                .get(index)
                .is_some_and(|range| point > range[1].as_u64().unwrap() as u32)
            {
                index += 1;
            }
            let expected = ranges
                .get(index)
                .is_some_and(|range| point >= range[0].as_u64().unwrap() as u32);
            let actual = match row["name"].as_str().unwrap() {
                "word" => python_regex::word(point),
                "space" => python_regex::space(point),
                "decimal" | "digit" => python_regex::decimal(point),
                _ => panic!("unknown source class"),
            };
            assert_eq!(actual, expected, "{} U+{point:04x}", row["name"]);
        }
    }
    let row: Value =
        serde_json::from_str(include_str!("fixtures/cpython313-simple-case-r1.json")).unwrap();
    for name in ["upper", "lower"] {
        let mappings = row[name].as_array().unwrap();
        let mut index = 0;
        for point in 0..=0x10ffff {
            let expected = if mappings
                .get(index)
                .is_some_and(|pair| point == pair[0].as_u64().unwrap() as u32)
            {
                let result = mappings[index][1].as_u64().unwrap() as u32;
                index += 1;
                result
            } else {
                point
            };
            let actual = if name == "upper" {
                python_regex::simple_upper(point)
            } else {
                python_regex::simple_lower(point)
            };
            assert_eq!(actual, expected, "{name} U+{point:04x}");
        }
        assert_eq!(index, mappings.len());
    }
}
