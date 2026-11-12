use super::*;
use libyaml_safer::ScalarStyle;
use regex_lite::Regex;
use std::sync::OnceLock;
mod integer_value;
mod number;
pub(super) use integer_value::integer_value;
mod timestamp;

pub(super) fn construct(
    value: &str,
    tag: Option<&str>,
    style: ScalarStyle,
    restore: &yaml_text::Restoration,
) -> Result<CdiValue> {
    let kind = kind(value, tag, style)?;
    match kind.as_str() {
        "str" => Ok(CdiValue::Text(restore.text(value))),
        "null" => Ok(CdiValue::Primitive(Value(Node::Null))),
        "bool"
            if matches!(
                value.to_ascii_lowercase().as_str(),
                "yes" | "no" | "true" | "false" | "on" | "off"
            ) =>
        {
            Ok(CdiValue::Primitive(Value(Node::Bool(matches!(
                value.to_ascii_lowercase().as_str(),
                "yes" | "true" | "on"
            )))))
        }
        "int" if number::integer(value) => Ok(CdiValue::YamlInteger(value.into())),
        "float" => number::float_value(value)
            .map(|value| CdiValue::Primitive(Value(Node::Number(Number::Float(value)))))
            .ok_or(GpuDataError::CdiDocument),
        "timestamp" if timestamp::valid(value) => Ok(CdiValue::Atom),
        "binary" => number::binary(value).map(CdiValue::Bytes),
        _ => Err(GpuDataError::CdiDocument),
    }
}
pub(super) fn kind(value: &str, tag: Option<&str>, style: ScalarStyle) -> Result<String> {
    let explicit = tag.filter(|tag| *tag != "!");
    let kind = match explicit {
        Some(tag) => tag
            .strip_prefix("tag:yaml.org,2002:")
            .ok_or(GpuDataError::CdiDocument)?,
        None if tag == Some("!") || style != ScalarStyle::Plain => "str",
        None => implicit(value),
    };
    Ok(kind.into())
}
fn matches(pattern: &'static str, slot: &'static OnceLock<Regex>, value: &str) -> bool {
    slot.get_or_init(|| Regex::new(pattern).expect("fixed Python YAML resolver pattern"))
        .is_match(value)
}
fn implicit(value: &str) -> &'static str {
    static BOOL: OnceLock<Regex> = OnceLock::new();
    static INT: OnceLock<Regex> = OnceLock::new();
    static FLOAT: OnceLock<Regex> = OnceLock::new();
    static TIME: OnceLock<Regex> = OnceLock::new();
    if matches!(value, "" | "~" | "null" | "Null" | "NULL") {
        return "null";
    }
    if matches(
        r"\A(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)\z",
        &BOOL,
        value,
    ) {
        return "bool";
    }
    if matches(
        r"\A(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))\z",
        &FLOAT,
        value,
    ) {
        return "float";
    }
    if matches(
        r"\A(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)\z",
        &INT,
        value,
    ) {
        return "int";
    }
    if matches(
        r"\A(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::[0-9]{2})?))?)\z",
        &TIME,
        value,
    ) {
        return "timestamp";
    }
    if value == "<<" {
        return "merge";
    }
    if value == "=" {
        return "value";
    }
    "str"
}
