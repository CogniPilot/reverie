CREATE TABLE IF NOT EXISTS hands_journal (
    id INTEGER PRIMARY KEY,
    turn_id TEXT UNIQUE NOT NULL,
    committed_ms REAL NOT NULL,
    payload_hash TEXT NOT NULL,
    payload TEXT NOT NULL,
    end_at REAL NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS hands_journal_fts USING fts5(text);
CREATE TABLE IF NOT EXISTS hands_journal_links (
    superseding_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    PRIMARY KEY(superseding_id,target_id)
);
CREATE INDEX IF NOT EXISTS hands_journal_links_target
    ON hands_journal_links(target_id,superseding_id);
