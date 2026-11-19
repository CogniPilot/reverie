//! Wire accounting for the tool definitions sent with a Hands model request.

/// Measure a tool schema as the legacy request budget did: JSON with ASCII
/// escapes and a space after each separator.
pub fn tool_schema_chars(json: &str) -> Option<usize> {
    let schema = crate::legacy_json::decode_python_str_ordered(json.as_bytes()).ok()?;
    Some(schema.encode().len())
}

#[cfg(test)]
mod tests {
    use super::tool_schema_chars;

    #[test]
    fn counts_escaped_text_and_default_separator_spacing() {
        let compact = r#"[{"name":"é💡","bounds":[1e-6,1e16],"pattern":"\n"}]"#;
        let spaced =
            r#"[{"name": "\u00e9\ud83d\udca1", "bounds": [1e-06, 1e+16], "pattern": "\n"}]"#;
        assert_eq!(tool_schema_chars(compact), Some(spaced.len()));
    }
}
