use super::*;

fn round_trip(text: &str) -> String {
    let value = parse(text, 1000).expect("valid JSON");
    let mut output = String::new();
    stringify(&value, &mut output);
    output
}

fn number_text(value: f64) -> String {
    let mut output = String::new();
    number(value, &mut output);
    output
}

#[test]
fn index_keys_come_first_then_creation_order() {
    assert_eq!(
        round_trip(r#"{"b":1,"1":2,"a":3,"0":4}"#),
        r#"{"0":4,"1":2,"b":1,"a":3}"#
    );
    // Not canonical indices: a leading zero, 2^32 - 1, a sign.
    assert_eq!(
        round_trip(r#"{"01":1,"4294967295":2,"-1":3,"4294967294":4}"#),
        r#"{"4294967294":4,"01":1,"4294967295":2,"-1":3}"#
    );
}

#[test]
fn a_repeated_key_keeps_its_first_place_and_last_value() {
    assert_eq!(round_trip(r#"{"a":1,"b":2,"a":3}"#), r#"{"a":3,"b":2}"#);
    assert_eq!(
        round_trip(r#"{"__proto__":{"x":1}}"#),
        r#"{"__proto__":{"x":1}}"#
    );
}

#[test]
fn strings_escape_as_quote_json_string() {
    assert_eq!(
        round_trip(r#"["\u0001\ud800\u2028é\"\\\/\b\f\n\r\t"]"#),
        "[\"\\u0001\\ud800\u{2028}é\\\"\\\\/\\b\\f\\n\\r\\t\"]"
    );
}

#[test]
fn numbers_spell_as_number_to_string() {
    let cases: &[(f64, &str)] = &[
        (1e21, "1e+21"),
        (1e20, "100000000000000000000"),
        (1e-7, "1e-7"),
        (1e-6, "0.000001"),
        (0.1, "0.1"),
        (0.1 + 0.2, "0.30000000000000004"),
        (5e-324, "5e-324"),
        (-0.0, "0"),
        (12345678901234567890.0, "12345678901234567000"),
        (123456789012345678901.0, "123456789012345680000"),
        (9007199254740993.0, "9007199254740992"),
        (1.7976931348623157e308, "1.7976931348623157e+308"),
        (2.2250738585072014e-308, "2.2250738585072014e-308"),
        (123456789e-30, "1.23456789e-22"),
        (-1.5, "-1.5"),
        (f64::INFINITY, "null"),
        // Exact ties between two shortest candidates take the even one (V8, Node 22.23.3).
        (f64::from_bits(0xc310e0386bfd9055), "-1187533140485141.2"),
        (f64::from_bits(0x42d7deb9c788f068), "104981468160961.62"),
        (f64::from_bits(0xc2a97eb8b2dd8520), "-14016027651778.562"),
    ];
    for (value, expected) in cases {
        assert_eq!(number_text(*value), *expected, "{value:e}");
    }
    assert_eq!(
        round_trip("[1e400,-1e400,-0,1E2,1.0]"),
        "[null,null,0,100,1]"
    );
}

#[test]
fn grammar_follows_json_parse() {
    for text in [
        "",
        " ",
        "[1,]",
        "{\"a\":1,}",
        "01",
        "1.",
        ".5",
        "+1",
        "\"\u{1}\"",
        "'a'",
        "nul",
        "[1]x",
        "\u{feff}{}",
        "{\"a\" 1}",
        "\"\\x\"",
        "\"\\u12\"",
        "\u{a0}1",
    ] {
        assert_eq!(parse(text, 1000), Err(ParseError::Syntax), "{text:?}");
    }
    assert_eq!(
        round_trip(" \t\r\n{ \"a\" : [ true , false , null ] } \n"),
        r#"{"a":[true,false,null]}"#
    );
}

#[test]
fn depth_is_bounded_only_for_valid_json() {
    let nested = |depth: usize| "[".repeat(depth) + &"]".repeat(depth);
    assert!(parse(&nested(1000), 1000).is_ok());
    assert_eq!(parse(&nested(1001), 1000), Err(ParseError::Depth));
    // Deep and invalid is a syntax error, as `JSON.parse` sees it, not a depth refusal.
    assert_eq!(parse(&"[".repeat(5000), 1000), Err(ParseError::Syntax));
    let objects = "{\"a\":".repeat(100_000) + "1" + &"}".repeat(100_000);
    assert_eq!(parse(&objects, 1000), Err(ParseError::Depth));
}
