use super::*;
/// Named self-write intent. Prepared prechecks are not the current writer body;
/// the writer must prepare this same draft/reason again after its revision CAS.
#[derive(Clone, Copy)]
pub(super) struct SelfIntent<'a, 'vote> {
    pub(super) model: &'a SelfModelDraft,
    pub(super) reason: &'a MetadataText,
    pub(super) vote: Option<&'a RecordedBallot<'vote>>,
}
impl MemoryDocuments<'_> {
    pub fn write(
        &self,
        name: &DocumentName,
        body: &DocumentBody,
        revision: DocumentRevision,
    ) -> Result<DocumentEnvelope> {
        self.install(name, body, revision, None)
    }
    fn install(
        &self,
        name: &DocumentName,
        body: &DocumentBody,
        revision: DocumentRevision,
        intent: Option<SelfIntent<'_, '_>>,
    ) -> Result<DocumentEnvelope> {
        self.store
            .session(|tx| install_on(tx, &self.context(), name, body, revision, intent))?;
        self.read(name, None)
    }
    pub fn save_self(
        &self,
        model: &SelfModelDraft,
        reason: &MetadataText,
        revision: DocumentRevision,
    ) -> Result<DocumentEnvelope> {
        self.save_self_checked(model, reason, revision, None)
    }
    pub fn save_self_with_vote(
        &self,
        model: &SelfModelDraft,
        reason: &MetadataText,
        revision: DocumentRevision,
        vote: &RecordedBallot<'_>,
    ) -> Result<DocumentEnvelope> {
        self.save_self_checked(model, reason, revision, Some(vote))
    }
    fn save_self_checked(
        &self,
        model: &SelfModelDraft,
        reason: &MetadataText,
        revision: DocumentRevision,
        vote: Option<&RecordedBallot<'_>>,
    ) -> Result<DocumentEnvelope> {
        let current = self.self_model()?;
        let change = model.prepare(&current.body, reason)?;
        // Preserve the source's pre-CAS core-change check. The writer repeats
        // preparation and recorded-ballot check against the actual current body
        // once the SQLite writer lock is held.
        self.store.session(|tx| {
            self.context()
                .check_self_vote(tx, current.revision.value(), &change, vote)
        })?;
        self.install(
            &DocumentName::from_scalar_text("self"),
            change.body(),
            revision,
            Some(SelfIntent {
                model,
                reason,
                vote,
            }),
        )
    }
}
impl DocumentContext<'_> {
    pub(super) fn check_self_vote(
        &self,
        tx: &MemoryTransaction<'_>,
        current: i64,
        change: &SelfModelChange,
        vote: Option<&RecordedBallot<'_>>,
    ) -> Result<()> {
        if current == 0 || !change.core_changed() {
            return Ok(());
        }
        let vote = vote.ok_or(MemoryError::CoreChangeRequiresVote)?;
        if !std::ptr::eq(vote.store, self.store)
            || vote.outcome.category != "core"
            || !vote.outcome.approved
            || vote.week != ballot_week((self.clock)())?
            || vote.outcome.proposal_hash != change.core_proposal().sha256()?
        {
            return Err(MemoryError::CoreChangeRequiresVote);
        }
        if ballot_streak(
            tx,
            &vote.outcome.category,
            vote.week,
            &vote.outcome.proposal_hash,
        )? != 3
        {
            return Err(MemoryError::CoreChangeRequiresVote);
        }
        Ok(())
    }
}
pub(super) fn install_on(
    tx: &mut MemoryTransaction<'_>,
    context: &DocumentContext<'_>,
    name: &DocumentName,
    body: &DocumentBody,
    revision: DocumentRevision,
    intent: Option<SelfIntent<'_, '_>>,
) -> Result<()> {
    let encoded = body.bounded_json_text()?;
    tx.connection_scope(|tx| install_fields(tx, context, name, &encoded, revision, intent))
}
pub(super) fn install_initial_in_atomic(
    tx: &mut MemoryTransaction<'_>,
    context: &DocumentContext<'_>,
    model: &SelfModelDraft,
    reason: &MetadataText,
    change: &SelfModelChange,
) -> Result<()> {
    if tx.depth == 0 || tx.db.is_autocommit() {
        return Err(MemoryError::ActiveTransaction);
    }
    let encoded = change.body().bounded_json_text()?;
    tx.own_transaction(|tx| {
        install_fields(
            tx,
            context,
            &DocumentName::from_scalar_text("self"),
            &encoded,
            DocumentRevision::try_new(0)?,
            Some(SelfIntent {
                model,
                reason,
                vote: None,
            }),
        )
    })
}
fn install_fields(
    tx: &mut MemoryTransaction<'_>,
    context: &DocumentContext<'_>,
    name: &DocumentName,
    encoded: &MetadataText,
    revision: DocumentRevision,
    intent: Option<SelfIntent<'_, '_>>,
) -> Result<()> {
    tx.begin_write()?;
    let selected = name_text(name)?;
    let inserted = tx.db.execute(
        "INSERT OR IGNORE INTO reverie_documents VALUES (?,0,'null',?)",
        params![selected, (context.clock)()],
    )?;
    let current: i64 = tx.db.query_row(
        "SELECT revision FROM reverie_documents WHERE name=?",
        [&selected],
        |row| row.get(0),
    )?;
    if current != revision.value() {
        return Err(MemoryError::DocumentConflict {
            expected: revision.value(),
            current,
        });
    }
    let change = intent
        .map(|intent| prepare_current(tx, context, &selected, inserted != 0, current, intent))
        .transpose()?;
    let prepared = change
        .as_ref()
        .map(|change| change.body().bounded_json_text())
        .transpose()?;
    let encoded = prepared.as_ref().unwrap_or(encoded);
    tx.db.execute("INSERT OR IGNORE INTO reverie_document_history SELECT name,revision,body,? FROM reverie_documents WHERE name=? AND revision>0",params![(context.clock)(),selected])?;
    tx.db.execute(
        "UPDATE reverie_documents SET revision=?,body=?,updated_at=? WHERE name=?",
        params![
            revision.next()?.value(),
            sql_text(encoded)?,
            (context.clock)(),
            selected
        ],
    )?;
    if let Some(change) = &change {
        update_beliefs(tx, change)?;
    }
    Ok(())
}
fn prepare_current(
    tx: &MemoryTransaction<'_>,
    context: &DocumentContext<'_>,
    name: &str,
    inserted: bool,
    revision: i64,
    intent: SelfIntent<'_, '_>,
) -> Result<SelfModelChange> {
    let current = if inserted {
        context.initial_self.clone()
    } else {
        let raw: String = tx.db.query_row(
            "SELECT body FROM reverie_documents WHERE name=?",
            [name],
            |row| row.get(0),
        )?;
        DocumentBody::decode_json(&raw)?
    };
    let change = intent.model.prepare(&current, intent.reason)?;
    context.check_self_vote(tx, revision, &change, intent.vote)?;
    Ok(change)
}
fn update_beliefs(tx: &mut MemoryTransaction<'_>, change: &SelfModelChange) -> Result<()> {
    let mut root = tx
        .get_state("self_model_root_id", None)?
        .filter(|v| !v.is_empty());
    if root.is_none() {
        let current = change
            .prior_consciousness()
            .and_then(MetadataText::scalar_text);
        let selected = sql_text(change.consciousness())?;
        root = tx
            .beliefs()?
            .into_iter()
            .find(|b| {
                b.parent_id.is_none()
                    && !b.text.is_empty()
                    && (b.text == selected || current.as_ref() == Some(&b.text))
            })
            .map(|b| b.id.to_string());
        if let Some(root) = &root {
            tx.db.execute(
                "INSERT OR REPLACE INTO state VALUES ('self_model_root_id',?)",
                [root],
            )?;
        }
    }
    if let Some(root) = root {
        tx.db.execute(
            "UPDATE beliefs SET text=?,protected=0 WHERE id=?",
            params![sql_text(change.consciousness())?, root],
        )?;
    }
    tx.db.execute(
        "INSERT OR REPLACE INTO state VALUES ('revisable_self_model','1')",
        [],
    )?;
    Ok(())
}
