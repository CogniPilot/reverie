use super::*;
use reverie_application::memory_lifecycle::InstalledMemory;
use reverie_contracts::memory_cli::{JournalSaveRequest, MemoryRequest};
use reverie_core::memory::{EmbeddingText, MemoryScope, ProjectName};
use reverie_host::memory_screen::{MemoryScreen, memory_stdin_text};
use std::io::Read;

const JOURNAL_REQUEST_BYTES: u64 = 1024 * 1024;

pub(super) fn run(
    arguments: &Arguments,
    installed: Option<&reverie_core::memory_context::InstalledMemoryContext>,
) -> Result<MemoryReply> {
    if arguments.initialize {
        return initialize(arguments);
    }
    let stdin = io::stdin().lock();
    if arguments.journal_only {
        return journal_only(stdin);
    }
    match read_request(stdin, u64::MAX)? {
        MemoryRequest::Screen { text } => Ok(MemoryReply::screened(screen(&text)?)),
        MemoryRequest::Recall { scope, query } => recall(arguments, installed, &scope, &query),
        MemoryRequest::Remember { request } => remember(&request),
    }
}
fn read_request(stdin: impl Read, bound: u64) -> Result<MemoryRequest> {
    let mut input = Vec::new();
    stdin
        .take(bound.saturating_add(1))
        .read_to_end(&mut input)
        .map_err(Failure::display)?;
    if input.len() as u64 > bound {
        return Err(Failure::text("memory request is too large"));
    }
    MemoryRequest::decode(memory_stdin_text(&input).as_text_ref()).map_err(Failure::display)
}
fn journal_only(stdin: impl Read) -> Result<MemoryReply> {
    match read_request(stdin, JOURNAL_REQUEST_BYTES)? {
        MemoryRequest::Recall { scope, query } => journal::recall(&scope, &query, Vec::new()),
        MemoryRequest::Remember { request } => remember(&request),
        MemoryRequest::Screen { .. } => Err(Failure::text("expected a recall or remember request")),
    }
}
fn remember(request: &JournalSaveRequest) -> Result<MemoryReply> {
    if !screen(request.text())?.is_empty() {
        return Err(Failure::text("memory is empty or crossed a hard floor"));
    }
    journal::save(request)
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
    Failure::finalized(result, close(&service))
}
fn recall(
    arguments: &Arguments,
    installed: Option<&reverie_core::memory_context::InstalledMemoryContext>,
    scope: &MemoryScope,
    query: &MetadataText,
) -> Result<MemoryReply> {
    if installed.is_some_and(|context| context.resource_for(scope).is_none()) {
        return Err(Failure::text("memory scope is not configured"));
    }
    let selected = match installed {
        Some(context) => InstalledMemory::capture_context(context),
        None => InstalledMemory::capture_instance(arguments.instance.as_deref()),
    };
    let service = selected.map_err(Failure::display)?;
    let result = service
        .recall(
            scope,
            EmbeddingText::from_codepoints(query.codepoints()).expect("checked request text"),
        )
        .map_err(Failure::display);
    let memories = Failure::finalized(result, close(&service))?;
    journal::recall(scope, query, memories)
}
fn close(service: &InstalledMemory) -> Result<()> {
    settle(|| service.shutdown()).map_err(Failure::display)
}
