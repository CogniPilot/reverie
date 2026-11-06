use super::*;
use reverie_contracts::{
    memory::MemoryView,
    memory_cli::{JournalEntries, JournalSaveData, JournalSaveRequest},
};
use reverie_core::memory::MemoryScope;
use reverie_host::memory_journal::{JournalClientError, JournalSignals, MemoryJournalClient};
use std::time::Instant;
pub(super) fn save(request: &JournalSaveRequest) -> Result<MemoryReply> {
    let Some(client) = MemoryJournalClient::capture().map_err(Failure::display)? else {
        return Err(copy_failure(
            "remember saves to your office journal as your own Reverie session, and this process is not running inside one. Nothing was saved. Inside your session, run: ",
            request,
        ));
    };
    if !request.missing().is_empty() {
        close(&client, None)?;
        return Err(copy_failure(
            &format!(
                "remember needs {}. Nothing was saved. To save it to your journal, run: ",
                request.missing().join(", ")
            ),
            request,
        ));
    }
    let mut signals = JournalSignals::install_for_standalone_process().map_err(Failure::display)?;
    let result: std::result::Result<JournalSaveData, JournalClientError> =
        client.save(request, deadline(), signals.cancellation());
    let restored = finish(&client, &mut signals);
    let result = result.map(MemoryReply::saved).map_err(problem);
    restored?;
    result
}
pub(super) fn recall(
    scope: &MemoryScope,
    query: &MetadataText,
    memories: Vec<MemoryView>,
) -> Result<MemoryReply> {
    let Some(client) = MemoryJournalClient::capture().map_err(Failure::display)? else {
        return Ok(MemoryReply::recalled(&memories));
    };
    let mut signals = JournalSignals::install_for_standalone_process().map_err(Failure::display)?;
    let project = match scope {
        MemoryScope::Private => None,
        MemoryScope::Project(project) => Some(project),
    };
    let result: std::result::Result<JournalEntries, JournalClientError> =
        client.recall(query, project, deadline(), signals.cancellation());
    finish(&client, &mut signals)?;
    Ok(match result {
        Ok(entries) => MemoryReply::recalled_with_journal(&memories, &entries),
        Err(error) => MemoryReply::recalled_after_journal_refusal(&memories, &problem(error).0),
    })
}
fn problem(error: JournalClientError) -> Failure {
    if !error.save_is_unconfirmed()
        && let Some(message) = error.message()
    {
        return Failure(message.clone(), 1);
    }
    Failure::display(error)
}
fn copy_failure(message: &str, request: &JournalSaveRequest) -> Failure {
    let mut points = message.chars().map(u32::from).collect::<Vec<_>>();
    points.extend_from_slice(request.copy_command().codepoints());
    Failure(
        MetadataText::from_python_text(
            reverie_core::PythonText::try_new(points).expect("checked journal text"),
        ),
        1,
    )
}
fn finish(client: &MemoryJournalClient, signals: &mut JournalSignals) -> Result<()> {
    let closed = close(client, Some(signals));
    if let Err(error) = signals.finish() {
        retain(|| signals.finish().is_ok(), &error.to_string());
        return Err(Failure::text("journal signal restoration was unconfirmed"));
    }
    if let Some(signal) = signals.termination_signal() {
        return Err(Failure(
            MetadataText::from_scalar_text(
                "journal operation interrupted; inspect the journal before another save",
            ),
            (128 + signal) as u8,
        ));
    }
    closed
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(60)
}
fn close(client: &MemoryJournalClient, signals: Option<&JournalSignals>) -> Result<()> {
    let limit = signals.map_or_else(deadline, |signals| signals.cleanup_deadline(deadline()));
    match client.close(limit) {
        Ok(()) => Ok(()),
        Err(error) => {
            retain(|| client.close(Instant::now()).is_ok(), &error.to_string());
            Err(Failure::text(
                "journal client cleanup was unconfirmed; inspect the journal before another save",
            ))
        }
    }
}
