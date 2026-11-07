use super::*;
pub struct BallotHistory {
    pub category: String,
    pub week: i64,
    pub proposal_hash: String,
    pub proposal: String,
    pub reason: String,
    pub at: f64,
}
pub(super) fn history_on(
    tx: &MemoryTransaction<'_>,
    name: &DocumentName,
) -> Result<Vec<DocumentHistory>> {
    let name = name_text(name)?;
    let mut statement=tx.db.prepare("SELECT name,revision,body,archived_at FROM reverie_document_history WHERE name=? ORDER BY revision DESC")?;
    let mut rows = statement.query([&name])?;
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        result.push(DocumentHistory {
            name: row.get(0)?,
            revision: DocumentRevision::try_new(row.get(1)?)?,
            body: row.get(2)?,
            archived_at: row.get(3)?,
        });
    }
    Ok(result)
}
pub(super) fn profile_names(tx: &MemoryTransaction<'_>) -> Result<Vec<String>> {
    let mut statement = tx.db.prepare(
        "SELECT name FROM reverie_documents WHERE name LIKE 'developer:%' ORDER BY name",
    )?;
    Ok(statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}
pub(super) fn ballots_on(tx: &MemoryTransaction<'_>) -> Result<Vec<BallotHistory>> {
    let mut statement=tx.db.prepare("SELECT category,week,proposal_hash,proposal,reason,at FROM reverie_ballots ORDER BY at DESC LIMIT 100")?;
    Ok(statement
        .query_map([], |row| {
            Ok(BallotHistory {
                category: row.get(0)?,
                week: row.get(1)?,
                proposal_hash: row.get(2)?,
                proposal: row.get(3)?,
                reason: row.get(4)?,
                at: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}
