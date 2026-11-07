//! Reentry through the existing explicit transaction argument, never by
//! relocking MemoryStore's Mutex. SQL operations share the same named owners.
use super::*;
pub struct TransactionDocuments<'tx, 'connection> {
    pub(super) tx: &'tx mut MemoryTransaction<'connection>,
    pub(super) context: DocumentContext<'tx>,
}
impl<'tx, 'connection> TransactionDocuments<'tx, 'connection> {
    /// Curated startup CAS only: create revision1 if no self document exists,
    /// preserving the caller's actual outer transaction. Existing self data is
    /// never replaced. Ordinary legacy save_self retains its commit semantics.
    pub fn initialize_identity(
        &mut self,
        model: &SelfModelDraft,
        reason: &MetadataText,
    ) -> Result<bool> {
        let current = self.self_model()?;
        if current.revision.value() != 0 {
            return Ok(false);
        }
        let change = model.prepare(&current.body, reason)?;
        write::install_initial_in_atomic(self.tx, &self.context, model, reason, &change)?;
        Ok(true)
    }
    pub fn vote(
        &mut self,
        category: &BallotCategory,
        proposal: &BallotProposal,
        reason: &MetadataText,
    ) -> Result<RecordedBallot<'tx>> {
        ballots::vote_on(
            self.tx,
            self.context.store,
            self.context.clock,
            category,
            proposal,
            reason,
        )
    }
    pub fn initialize(&mut self) -> Result<()> {
        self.tx.connection_scope(|tx| {
            tx.db.execute_batch(SCHEMA)?;
            Ok(())
        })
    }
    pub fn read(
        &self,
        name: &DocumentName,
        default: Option<DocumentBody>,
    ) -> Result<DocumentEnvelope> {
        read_on(self.tx, name, default)
    }
    pub fn self_model(&self) -> Result<DocumentEnvelope> {
        self.read(
            &DocumentName::from_scalar_text("self"),
            Some(self.context.initial_self.clone()),
        )
    }
    pub fn plan(&self) -> Result<DocumentEnvelope> {
        self.read(
            &DocumentName::from_scalar_text("plan"),
            Some(DocumentBody::plan(&MetadataText::from_scalar_text(
                reverie_core::memory_documents::DEFAULT_PLAN,
            ))),
        )
    }
    pub fn render_self(&self) -> Result<MetadataText> {
        Ok(self.self_model()?.body.render_self()?)
    }
    pub fn history(&self, name: &DocumentName) -> Result<Vec<DocumentHistory>> {
        queries::history_on(self.tx, name)
    }
    pub fn ballot_history(&self) -> Result<Vec<BallotHistory>> {
        queries::ballots_on(self.tx)
    }
    pub fn profiles(&self) -> Result<BTreeMap<String, DocumentEnvelope>> {
        queries::profile_names(self.tx)?
            .into_iter()
            .map(|name| {
                let key = name
                    .strip_prefix("developer:")
                    .expect("SQL prefix")
                    .to_owned();
                Ok((
                    key,
                    self.read(&DocumentName::from_scalar_text(&name), None)?,
                ))
            })
            .collect()
    }
    pub fn brief(
        &self,
        request: &reverie_contracts::memory_documents::BriefRequest,
    ) -> Result<String> {
        let profiles = self
            .profiles()?
            .into_iter()
            .map(|(name, value)| (name, value.body))
            .collect();
        Ok(request.render(&profiles)?)
    }
    pub fn write(
        &mut self,
        name: &DocumentName,
        body: &DocumentBody,
        revision: DocumentRevision,
    ) -> Result<DocumentEnvelope> {
        write::install_on(self.tx, &self.context, name, body, revision, None)?;
        self.read(name, None)
    }
    pub fn save_profile(
        &mut self,
        name: &DeveloperName,
        body: &DocumentBody,
        revision: DocumentRevision,
    ) -> Result<DocumentEnvelope> {
        body.checked_profile(name)?;
        self.write(
            &DocumentName::from_scalar_text(&format!("developer:{}", name.as_str())),
            body,
            revision,
        )
    }
    pub fn save_self(
        &mut self,
        model: &SelfModelDraft,
        reason: &MetadataText,
        revision: DocumentRevision,
    ) -> Result<DocumentEnvelope> {
        self.save_self_checked(model, reason, revision, None)
    }
    pub fn save_self_with_vote(
        &mut self,
        model: &SelfModelDraft,
        reason: &MetadataText,
        revision: DocumentRevision,
        vote: &RecordedBallot<'_>,
    ) -> Result<DocumentEnvelope> {
        self.save_self_checked(model, reason, revision, Some(vote))
    }
    fn save_self_checked(
        &mut self,
        model: &SelfModelDraft,
        reason: &MetadataText,
        revision: DocumentRevision,
        vote: Option<&RecordedBallot<'_>>,
    ) -> Result<DocumentEnvelope> {
        let current = self.self_model()?;
        let change = model.prepare(&current.body, reason)?;
        self.context
            .check_self_vote(self.tx, current.revision.value(), &change, vote)?;
        let name = DocumentName::from_scalar_text("self");
        write::install_on(
            self.tx,
            &self.context,
            &name,
            change.body(),
            revision,
            Some(write::SelfIntent {
                model,
                reason,
                vote,
            }),
        )?;
        self.read(&name, None)
    }
}
