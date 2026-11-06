use reverie_core::python_regex;
pub(crate) fn identifier(points: &[u32]) -> bool {
    python_regex::is_identifier(points)
}
pub(crate) fn alpha(point: u32) -> bool {
    python_regex::alphabetic(point)
}
pub(crate) fn quoted(points: &[u32]) -> String {
    reverie_core::memory::quoted_memory_text(points).expect("checked Python codepoints")
}
pub(crate) fn lower(point: u32) -> u32 {
    python_regex::simple_lower(point)
}
pub(crate) fn upper(point: u32) -> u32 {
    python_regex::simple_upper(point)
}
pub(crate) fn extra(point: u32) -> &'static [u32] {
    python_regex::extra_cases(point)
}
pub(crate) fn named(name: &str) -> Option<u32> {
    python_regex::named_character(name)
}
