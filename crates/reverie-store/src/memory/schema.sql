CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    created_at REAL NOT NULL,
    user_text TEXT NOT NULL DEFAULT '',
    assistant_text TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    importance REAL NOT NULL,
    importance_source TEXT NOT NULL DEFAULT 'default',
    embed_model TEXT NOT NULL DEFAULT '',
    embedding BLOB,
    source_ids TEXT NOT NULL DEFAULT '[]',
    section TEXT NOT NULL DEFAULT '',
    meta TEXT NOT NULL DEFAULT '{}',
    last_accessed REAL
);
CREATE INDEX IF NOT EXISTS memories_kind_time ON memories(kind, created_at);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS answered (source_id TEXT PRIMARY KEY, at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS external_episodes (source_id TEXT PRIMARY KEY, memory_id INTEGER);
CREATE TABLE IF NOT EXISTS voice_claims (norm TEXT NOT NULL, at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS beliefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    weight REAL NOT NULL,
    parent_id INTEGER,
    protected INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);
