//! Fixed native pane argv DATA. No shell wrapper or caller-selected program.
use super::{MetadataText, tmux_exec_args};
use reverie_core::{
    ids::NativeOperationId,
    worker_child::{CHILD_PROGRAM, LAUNCH_DIRECTORY},
    worker_launch::{ContainerReference, TerminalSize},
};
pub fn pane_start_arguments(
    name: &ContainerReference<'_>,
    nonce: &NativeOperationId,
    terminal: TerminalSize,
) -> Vec<MetadataText> {
    let nonce = nonce.as_str();
    let record = format!("{LAUNCH_DIRECTORY}/{nonce}.json");
    let exit = format!("{LAUNCH_DIRECTORY}/{nonce}.exit");
    let cols = terminal.cols().to_string();
    let rows = terminal.rows().to_string();
    let words = [
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-x",
        &cols,
        "-y",
        &rows,
        "-s",
        "office",
        CHILD_PROGRAM,
        "--pane-exit",
        &exit,
        &record,
        ";",
        "set-option",
        "-g",
        "remain-on-exit",
        "on",
    ]
    .map(MetadataText::from_scalar_text);
    tmux_exec_args(name, &words, false)
}
pub fn pane_status_arguments(name: &ContainerReference<'_>) -> Vec<MetadataText> {
    tmux_exec_args(
        name,
        &["set-option", "-g", "status", "off"].map(MetadataText::from_scalar_text),
        false,
    )
}

/// Original single-field runtime.json bytes, without writing any path.
pub fn runtime_metadata(nonce: &NativeOperationId) -> Vec<u8> {
    use crate::legacy_json::{Node, Text, Value};
    let entry = (
        super::key("exit"),
        Value(Node::String(Text(
            format!("{}.exit", nonce.as_str())
                .chars()
                .map(u32::from)
                .collect(),
        ))),
    );
    crate::worker_config::encode_data(&Value(Node::Object([entry].into_iter().collect())))
}
