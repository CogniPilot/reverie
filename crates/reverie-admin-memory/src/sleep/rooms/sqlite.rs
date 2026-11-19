use super::{LOOKBACK, Result, member_room};
use rusqlite::{Connection, OpenFlags, params};
use serde_json::Value;
use std::{collections::BTreeSet, path::Path, time::Duration};

pub(super) fn load(path: &Path, ids: &BTreeSet<String>, since: f64) -> Result<Vec<Value>> {
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.busy_timeout(Duration::from_secs(10))?;
    let view = db.unchecked_transaction()?;
    let mut rooms = Vec::new();
    {
        let mut query = view.prepare("SELECT id, data FROM rooms ORDER BY id")?;
        let mut rows = query.query([])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let serialized: String = row.get(1)?;
            let mut room: Value = serde_json::from_str(&serialized)?;
            if !member_room(&room, ids) {
                continue;
            }
            let messages = messages(&view, &id, since as i64)?;
            if !messages.is_empty() {
                room["messages"] = Value::Array(messages);
                rooms.push(room);
            }
        }
    }
    view.commit()?;
    Ok(rooms)
}

fn messages(db: &Connection, room: &str, since: i64) -> Result<Vec<Value>> {
    let mut after =
        db.prepare("SELECT data FROM messages WHERE room_id = ? AND at > ? ORDER BY at, id")?;
    let after = after
        .query_map(params![room, since], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if after.is_empty() {
        return Ok(Vec::new());
    }
    let mut before = db.prepare(
        "SELECT data FROM messages WHERE room_id = ? AND at <= ? ORDER BY at DESC, id DESC LIMIT ?",
    )?;
    let before = before
        .query_map(params![room, since, LOOKBACK as i64], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    before
        .into_iter()
        .rev()
        .chain(after)
        .map(|raw| serde_json::from_str(&raw).map_err(Into::into))
        .collect()
}
