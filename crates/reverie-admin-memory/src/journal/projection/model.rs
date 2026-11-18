use super::super::message;
use crate::office::Office;
use reverie_contracts::memory::channel::journal::{JournalEntry, JournalMessage, SourceRevision};
use reverie_core::ids::{ChatMessageId, ChatRoomId};
use reverie_store::memory::{CORRECTION_LIMIT, JournalReader, JournalRow, MemoryError, Result};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

const MAX_SOURCE_READS: usize = 12;

pub(super) struct Record {
    pub(super) id: i64,
    pub(super) committed_ms: f64,
    pub(super) entry: JournalEntry,
}

impl Record {
    pub(super) fn decode(row: JournalRow) -> Result<Self> {
        if row.id <= 0 || !row.committed_ms.is_finite() || row.committed_ms < 0.0 {
            return Err(MemoryError::Integrity);
        }
        let entry = JournalEntry::decode(&row.payload).ok_or(MemoryError::Integrity)?;
        Ok(Self {
            id: row.id,
            committed_ms: row.committed_ms,
            entry,
        })
    }
}

pub(super) struct Model<'a, 'db> {
    store: &'a JournalReader<'db>,
    office: &'a Office,
    room: &'a ChatRoomId,
    as_of: Option<f64>,
    sources: BTreeMap<ChatMessageId, Option<JournalMessage>>,
    pub(super) omitted: bool,
}

pub(super) enum Currentness {
    Current,
    Superseded(Vec<Record>),
    Unresolved,
}

impl Currentness {
    pub(super) fn label(&self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Superseded(_) => "superseded",
            Self::Unresolved => "unresolved",
        }
    }

    pub(super) fn superseded_by(&self) -> Vec<i64> {
        match self {
            Self::Superseded(items) => items.iter().map(|item| item.id).collect(),
            _ => Vec::new(),
        }
    }
}

impl<'a, 'db> Model<'a, 'db> {
    pub(super) fn new(
        store: &'a JournalReader<'db>,
        office: &'a Office,
        room: &'a ChatRoomId,
        as_of: Option<f64>,
    ) -> Self {
        Self {
            store,
            office,
            room,
            as_of,
            sources: BTreeMap::new(),
            omitted: false,
        }
    }

    pub(super) fn project(
        &mut self,
        records: Vec<Record>,
        current_only: bool,
    ) -> Result<Vec<(Record, Currentness)>> {
        let mut result = Vec::new();
        let mut seen = BTreeSet::new();
        let mut pending: VecDeque<_> = records.into_iter().map(|record| (record, 0)).collect();
        while let Some((record, depth)) = pending.pop_front() {
            if !seen.insert(record.id) {
                continue;
            }
            if !self.checked(&record) {
                self.omitted = true;
                continue;
            }
            let state = self.currentness(&record)?;
            if !current_only || matches!(state, Currentness::Current) {
                result.push((record, state));
                continue;
            }
            self.omitted = true;
            if depth < 2
                && let Currentness::Superseded(items) = state
            {
                pending.extend(items.into_iter().map(|item| (item, depth + 1)));
            }
        }
        Ok(result)
    }

    fn checked(&mut self, record: &Record) -> bool {
        record
            .entry
            .cited_revisions(self.room)
            .is_some_and(|expected| {
                expected
                    .iter()
                    .all(|revision| self.source_matches(revision))
            })
    }

    fn source_matches(&mut self, revision: &SourceRevision) -> bool {
        let id = revision.id();
        if let Some(cached) = self.sources.get(id) {
            return cached.as_ref().is_some_and(|item| item.matches(revision));
        }
        if self.sources.len() == MAX_SOURCE_READS {
            self.omitted = true;
            return false;
        }
        let fetched = message(self.office, self.room, id).ok().flatten();
        let matched = fetched.as_ref().is_some_and(|item| item.matches(revision));
        self.sources.insert(id.clone(), fetched);
        matched
    }

    fn corrections(&self, target: i64) -> Result<Vec<Record>> {
        self.store
            .corrections(target, self.as_of)?
            .into_iter()
            .map(Record::decode)
            .collect()
    }

    fn currentness(&mut self, record: &Record) -> Result<Currentness> {
        let later = self.corrections(record.id)?;
        if later.len() > usize::from(CORRECTION_LIMIT) {
            self.omitted = true;
            return Ok(Currentness::Unresolved);
        }
        if !later.is_empty() {
            let checked = later
                .into_iter()
                .filter(|item| self.checked(item))
                .collect::<Vec<_>>();
            return Ok(if checked.is_empty() {
                Currentness::Unresolved
            } else {
                Currentness::Superseded(checked)
            });
        }
        self.resolve_siblings(record)
    }

    fn resolve_siblings(&mut self, record: &Record) -> Result<Currentness> {
        let targets: Vec<_> = record.entry.supersedes().collect();
        for &id in &targets {
            let siblings = self.corrections(id)?;
            if siblings.len() > usize::from(CORRECTION_LIMIT) {
                self.omitted = true;
                return Ok(Currentness::Unresolved);
            }
            if siblings
                .iter()
                .any(|item| item.id != record.id && !targets.contains(&item.id))
            {
                return Ok(Currentness::Unresolved);
            }
        }
        Ok(Currentness::Current)
    }
}
