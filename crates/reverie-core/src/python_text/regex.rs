//! Frozen CPython 3.13 / Unicode 15.1 facts shared by the native regex
//! compiler and the pinned matcher. No grammar, bytecode or effects live here.
use super::{alphabetic, identifier_continue, identifier_start, regex_casefix, upper_table};
pub fn word(point: u32) -> bool {
    super::word_point(point)
}
pub fn space(point: u32) -> bool {
    super::space_point(point)
}
pub fn decimal(point: u32) -> bool {
    super::decimal_point(point)
}
pub fn simple_lower(point: u32) -> u32 {
    super::lower_table::LOWER
        .binary_search_by_key(&point, |&(key, _)| key)
        .map_or(point, |index| super::lower_table::LOWER[index].1[0])
}
pub fn simple_upper(point: u32) -> u32 {
    upper_table::lookup(point)
}
pub fn is_identifier(points: &[u32]) -> bool {
    points
        .first()
        .is_some_and(|&point| identifier_start::contains(point))
        && points
            .iter()
            .skip(1)
            .all(|&point| identifier_continue::contains(point))
}
pub fn alphabetic(point: u32) -> bool {
    alphabetic::contains(point)
}
pub fn extra_cases(point: u32) -> &'static [u32] {
    regex_casefix::EXTRA_CASES
        .binary_search_by_key(&point, |&(key, _)| key)
        .map_or(&[], |index| regex_casefix::EXTRA_CASES[index].1)
}
pub fn named_character(name: &str) -> Option<u32> {
    // CPython 3.13 unicodedata.c parse_hex_code: maintained Unicode15.1
    // lookup otherwise admits a leading-zero algorithmic CJK spelling.
    const PREFIX: &[u8] = b"CJK UNIFIED IDEOGRAPH-";
    let bytes = name.as_bytes();
    if bytes
        .get(..PREFIX.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(PREFIX))
    {
        let digits = &bytes[PREFIX.len()..];
        if !(4..=6).contains(&digits.len())
            || digits.first() == Some(&b'0')
            || !digits.iter().all(u8::is_ascii_hexdigit)
        {
            return None;
        }
    }
    let point = unicode_names2::character(name)?;
    // The pinned lookup's canonical-name path compares every canonical
    // fragment but omits its final empty-remainder check. Its alias path is
    // an exact phf key lookup. Refuse only the erroneous canonical prefix
    // plus extra input; exact canonical spellings and exact aliases survive.
    if let Some(canonical) = unicode_names2::name(point) {
        let canonical = canonical.to_string();
        if bytes.len() > canonical.len()
            && bytes[..canonical.len()].eq_ignore_ascii_case(canonical.as_bytes())
        {
            return None;
        }
    }
    Some(u32::from(point))
}
