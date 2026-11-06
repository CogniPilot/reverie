use super::*;
use reverie_application::memory_lifecycle::InstalledMemory;
use reverie_contracts::memory_cli::MemoryRequest;
use reverie_core::memory::{EmbeddingText, MemoryScope, ProjectName};
use reverie_host::memory_screen::{MemoryScreen, memory_stdin_text};
use std::io::Read;
pub(super) fn run(arguments: &Arguments) -> Result<MemoryReply> {
    if arguments.initialize {
        return initialize(arguments);
    }
    let mut input = Vec::new();
    io::stdin()
        .lock()
        .read_to_end(&mut input)
        .map_err(Failure::display)?;
    let text = memory_stdin_text(&input);
    match MemoryRequest::decode(text.as_text_ref()).map_err(Failure::display)? {
        MemoryRequest::Screen { text } => Ok(MemoryReply::screened(screen(&text)?)),
        MemoryRequest::Recall { scope, query } => recall(arguments, &scope, &query),
        MemoryRequest::Remember { request } => {
            if !screen(request.text())?.is_empty() {
                return Err(Failure::text("memory is empty or crossed a hard floor"));
            }
            journal::save(&request)
        }
    }
}
fn screen(text: &MetadataText) -> Result<&'static str> {
    MemoryScreen::capture_current()
        .and_then(|policy| policy.check(text))
        .map_err(Failure::display)
}
fn initialize(arguments: &Arguments) -> Result<MemoryReply> {
    let scope = match &arguments.project {
        Some(name) => MemoryScope::Project(
            ProjectName::parse(name)
                .ok_or_else(|| Failure::text("project must be a lowercase project identifier"))?,
        ),
        None => MemoryScope::Private,
    };
    let service = InstalledMemory::capture_instance(arguments.instance.as_deref())
        .map_err(Failure::display)?;
    let result = service
        .startup(&scope, &[])
        .map_err(Failure::display)
        .map(|_| MemoryReply::initialized());
    close(&service)?;
    result
}
fn recall(arguments: &Arguments, scope: &MemoryScope, query: &MetadataText) -> Result<MemoryReply> {
    let service = InstalledMemory::capture_instance(arguments.instance.as_deref())
        .map_err(Failure::display)?;
    let result = service
        .recall(
            scope,
            EmbeddingText::from_codepoints(query.codepoints()).expect("checked request text"),
        )
        .map_err(Failure::display);
    close(&service)?;
    journal::recall(scope, query, result?)
}
fn close(service: &InstalledMemory) -> Result<()> {
    match service.close() {
        Ok(()) => Ok(()),
        Err(error) => {
            retain(|| service.close().is_ok(), &error.to_string());
            Err(Failure::text("memory scope finalization was unconfirmed"))
        }
    }
}
