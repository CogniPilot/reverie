//! Fixed interactive attach DATA. Marker bytes come from the host's fresh
//! viewer owner, not a guest-selected environment or process identity.
use super::{MetadataText, helpers::tmux_exec_environment};
use reverie_core::worker_launch::ContainerReference;
pub fn viewer_attach_arguments(
    name: &ContainerReference<'_>,
    marker: &[u8; 16],
) -> Vec<MetadataText> {
    let marker = marker
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    tmux_exec_environment(
        name,
        &["attach-session", "-d", "-t", "office"].map(MetadataText::from_scalar_text),
        true,
        &[MetadataText::from_scalar_text(&format!(
            "REVERIE_VIEWER={marker}"
        ))],
    )
}
