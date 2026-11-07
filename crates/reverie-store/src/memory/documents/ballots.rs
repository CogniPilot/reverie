use super::*;
#[derive(Clone, Debug, PartialEq)]
pub struct BallotOutcome {
    pub category: String,
    pub proposal_hash: String,
    pub consecutive_weeks: usize,
    pub approved: bool,
    pub next_week_at: i64,
}
/// Actual database-backed ballot evidence. No wire/digest/boolean constructor,
/// serde implementation or cross-store rebinding exists. Not owner authority.
///
/// ```compile_fail
/// use reverie_store::memory::{MemoryStore,RecordedBallot};
/// let store=MemoryStore::open(":memory:").unwrap();
/// let forged=RecordedBallot { store:&store, outcome:todo!(), week:0 };
/// ```
pub struct RecordedBallot<'a> {
    pub(super) store: &'a MemoryStore,
    pub(super) outcome: BallotOutcome,
    pub(super) week: i64,
}
impl RecordedBallot<'_> {
    pub fn outcome(&self) -> &BallotOutcome {
        &self.outcome
    }
}
impl<'a> MemoryDocuments<'a> {
    pub fn vote(
        &self,
        category: &BallotCategory,
        proposal: &BallotProposal,
        reason: &MetadataText,
    ) -> Result<RecordedBallot<'a>> {
        self.store
            .session(|tx| vote_on(tx, self.store, self.clock, category, proposal, reason))
    }
}
pub(super) fn vote_on<'a>(
    tx: &mut MemoryTransaction<'_>,
    store: &'a MemoryStore,
    clock: fn() -> f64,
    category: &BallotCategory,
    proposal: &BallotProposal,
    reason: &MetadataText,
) -> Result<RecordedBallot<'a>> {
    if reason.as_python_text_ref().trimmed().is_empty() {
        return Err(DocumentCodecError::Reason.into());
    }
    let raw = proposal.checked_canonical_text()?;
    let hash = proposal.sha256()?;
    let at = clock();
    let week = ballot_week(at)?;
    let streak = tx.connection_scope(|tx| {
        tx.begin_write()?;
        tx.db.execute(
            "INSERT OR IGNORE INTO reverie_ballots VALUES (?,?,?,?,?,?)",
            params![category.as_str(), week, hash, raw, sql_text(reason)?, at],
        )?;
        let current: String = tx.db.query_row(
            "SELECT proposal_hash FROM reverie_ballots WHERE category=? AND week=?",
            params![category.as_str(), week],
            |row| row.get(0),
        )?;
        if current != hash {
            return Err(MemoryError::BallotConflict);
        }
        ballot_streak(tx, category.as_str(), week, &hash)
    })?;
    let next_week_at = week
        .checked_add(1)
        .and_then(|v| v.checked_mul(604800))
        .and_then(|v| v.checked_add(345600))
        .ok_or(reverie_core::memory_documents::DocumentPolicyError)?;
    Ok(RecordedBallot {
        store,
        week,
        outcome: BallotOutcome {
            category: category.as_str().to_owned(),
            proposal_hash: hash,
            consecutive_weeks: streak,
            approved: streak == 3,
            next_week_at,
        },
    })
}
pub(super) fn ballot_streak(
    tx: &MemoryTransaction<'_>,
    category: &str,
    week: i64,
    hash: &str,
) -> Result<usize> {
    let mut streak = 0;
    for offset in 0..3 {
        let Some(candidate) = week.checked_sub(offset) else {
            break;
        };
        let actual: Option<String> = tx
            .db
            .query_row(
                "SELECT proposal_hash FROM reverie_ballots WHERE category=? AND week=?",
                params![category, candidate],
                |row| row.get(0),
            )
            .optional()?;
        if actual.as_deref() != Some(hash) {
            break;
        }
        streak += 1;
    }
    Ok(streak)
}
