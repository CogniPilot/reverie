//! Fixed interactive attach DATA. Marker bytes come from the host's fresh
//! viewer owner, not a guest-selected environment or process identity.
use super::{MetadataText, tmux_exec_args};
use reverie_core::worker_launch::ContainerReference;
pub fn viewer_attach_arguments(
    name: &ContainerReference<'_>,
    marker: &[u8; 16],
) -> Vec<MetadataText> {
    let marker = marker
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let mut args = tmux_exec_args(
        name,
        &["attach-session", "-d", "-t", "office"].map(MetadataText::from_scalar_text),
        true,
    );
    // Original tmux_exec_args places supplied environment after the four fixed
    // locale/terminal entries and immediately before its selected container.
    args.splice(
        10..10,
        [
            MetadataText::from_scalar_text("--env"),
            MetadataText::from_scalar_text(&format!("REVERIE_VIEWER={marker}")),
        ],
    );
    args
}
