//! Python skips only source-index-zero U+FEFF. Libyaml also treats later
//! line-start BOMs specially. Preserve those as collision-free scalar data;
//! never let that marker make invalid anchor/tag/directive syntax acceptable.
use super::*;
pub(super) fn has_data(raw: &str) -> bool {
    raw.char_indices()
        .any(|(index, point)| index > 0 && point == '\u{feff}')
}
pub(super) fn mask(raw: &str, marker: char) -> String {
    raw.char_indices()
        .map(|(index, point)| {
            if index > 0 && point == '\u{feff}' {
                marker
            } else {
                point
            }
        })
        .collect()
}
impl Restoration {
    pub(in crate::gpu_access::cdi) fn syntax(&self, value: Option<&str>) -> Result<()> {
        if self.bom.is_some_and(|point| {
            value
                .is_some_and(|value| value.contains(char::from_u32(point).expect("checked marker")))
        }) {
            Err(GpuDataError::CdiDocument)
        } else {
            Ok(())
        }
    }
}
