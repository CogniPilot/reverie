//! Screen model and training text without opening a store or selecting a model.
use crate::TURN_CAPTURE_BOUND;
use reverie_contracts::storage_identity::MetadataText;
use reverie_core::PythonText;
use reverie_host::memory_screen::MemoryScreen;
use serde_json::json;
use std::io;

pub(super) fn run(parent: i32) -> io::Result<()> {
    let input = crate::worker_input(parent, TURN_CAPTURE_BOUND)?;
    // A JSON string would merge adjacent surrogate codepoints.
    let texts = serde_json::from_slice::<Vec<Vec<u32>>>(&input)?
        .into_iter()
        .map(|points| PythonText::try_new(points).map(MetadataText::from_python_text))
        .collect::<Result<Vec<_>, _>>()
        .map_err(io::Error::other)?;
    let reasons = MemoryScreen::capture_current()
        .and_then(|screen| screen.check_many(&texts))
        .map_err(io::Error::other)?;
    crate::write_reply(&json!({ "reasons": reasons }), TURN_CAPTURE_BOUND)
}
