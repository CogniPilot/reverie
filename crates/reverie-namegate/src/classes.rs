//! Character classes with Python `re` semantics for `str` patterns (Unicode mode), checked
//! code point by code point against the reference interpreter in the tests.

use unicode_properties::{GeneralCategory, GeneralCategoryGroup, UnicodeGeneralCategory};

/// Python `\w`: letters, numbers and underscore.
pub(crate) fn is_word(ch: char) -> bool {
    ch == '_'
        || matches!(
            ch.general_category_group(),
            GeneralCategoryGroup::Letter | GeneralCategoryGroup::Number
        )
}

/// Python `\d`: decimal digits.
pub(crate) fn is_decimal(ch: char) -> bool {
    ch.general_category() == GeneralCategory::DecimalNumber
}

/// Python `\s` and `str.split()` whitespace, which includes the U+001C..U+001F separators.
pub(crate) fn is_space(ch: char) -> bool {
    ch.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&ch)
}

/// Python `[^\W\d_]`: word characters that are neither decimal digits nor underscore.
pub(crate) fn is_letter_run(ch: char) -> bool {
    is_word(ch) && !is_decimal(ch) && ch != '_'
}

/// Unicode general category Cf (format characters such as zero-width space).
pub(crate) fn is_format(ch: char) -> bool {
    ch.general_category() == GeneralCategory::Format
}

/// Python `re.IGNORECASE` equality of a list character against text. List entries are ASCII in
/// practice; for ASCII letters Python also folds U+0130 and U+0131 to `i`, U+017F to `s` and
/// U+212A to `k`. Any other list character matches only itself.
pub(crate) fn ignorecase_eq(pattern: char, text: char) -> bool {
    if pattern == text {
        return true;
    }
    if !pattern.is_ascii_alphabetic() {
        return false;
    }
    let lower = pattern.to_ascii_lowercase();
    (text.is_ascii() && text.to_ascii_lowercase() == lower)
        || matches!(
            (lower, text),
            ('i', '\u{130}' | '\u{131}') | ('s', '\u{17f}') | ('k', '\u{212a}')
        )
}
