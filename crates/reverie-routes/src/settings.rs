//! `GET /api/settings`: read exactly the path TS computed, then answer as `settings_v1` does. A
//! relative path resolves against this process's working directory, which it inherits from TS.
use reverie_contracts::settings_v1::{self as v1, MAX_FILE_BYTES, Refusal, Response};
use std::fs::File;
use std::io::Read;

pub fn answer(json: &[u8]) -> Result<Response, Refusal> {
    let request = v1::decode_request(json)?;
    v1::respond(read(&request.settings_path)?.as_deref())
}

/// The file's bytes; `None` for any failure to open or read it (missing, unreadable, a directory),
/// all of which TS answers with its default. Reads at most one byte past the bound.
fn read(path: &str) -> Result<Option<Vec<u8>>, Refusal> {
    let Ok(file) = File::open(path) else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    match file.take(MAX_FILE_BYTES as u64 + 1).read_to_end(&mut bytes) {
        Ok(_) if bytes.len() > MAX_FILE_BYTES => Err(Refusal::FileBound),
        Ok(_) => Ok(Some(bytes)),
        Err(_) => Ok(None),
    }
}
