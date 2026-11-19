//! Shared removal of model-private thinking and detection of textual tool calls.
use regex_lite::Regex;
use reverie_core::{PythonTextRef, memory::trim_text};
use reverie_python_regex::CompiledOutputPolicy;
use std::{borrow::Cow, sync::LazyLock};

const COMMON_MARKUP: &str = r"(?i)</?tool_call\b|<\|tool_call|<function[=\s>]";
static THINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<think>.*?</think>").unwrap());
static CODING_MARKUP: LazyLock<Regex> = LazyLock::new(|| Regex::new(COMMON_MARKUP).unwrap());
static CHAT_MARKUP: LazyLock<CompiledOutputPolicy> = LazyLock::new(|| {
    let pattern = format!(
        "{COMMON_MARKUP}|{}",
        r#"<parameter[=\s>]|"name"\s*:\s*"web_(?:search|fetch)""#
    );
    CompiledOutputPolicy::compile([PythonTextRef::from_scalar_text(&pattern)])
        .expect("fixed reply markup")
});

pub(super) fn visible(text: &str) -> Cow<'_, str> {
    match THINK.replace_all(text, "") {
        Cow::Borrowed(text) => Cow::Borrowed(trim_text(text)),
        Cow::Owned(text) => Cow::Owned(trim_text(&text).to_owned()),
    }
}

pub(super) fn coding_markup(text: &str) -> bool {
    CODING_MARKUP.is_match(text)
}

pub(super) fn chat_markup(text: &str) -> bool {
    CHAT_MARKUP.is_match(PythonTextRef::from_scalar_text(text))
}
