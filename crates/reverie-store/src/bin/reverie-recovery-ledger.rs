//! One bounded operation over a private SQLite ledger.
use reverie_store::recovery_ledger::{Ledger, Request, Response};
use serde::Serialize;
use std::{
    io::{self, Read, Write},
    path::Path,
    process::ExitCode,
};

const MAX_INPUT: u64 = 8192;
const MAX_OUTPUT: usize = 262144;
const UNAVAILABLE: &[u8] = br#"{"ok":false,"code":"LEDGER_UNAVAILABLE"}"#;

#[derive(Serialize)]
struct Reply {
    ok: bool,
    result: Response,
}

fn process() -> Option<Vec<u8>> {
    let mut args = std::env::args_os().skip(1);
    let file = args.next()?;
    if args.next().is_some() {
        return None;
    }
    let mut input = Vec::new();
    io::stdin()
        .lock()
        .take(MAX_INPUT + 1)
        .read_to_end(&mut input)
        .ok()?;
    if input.len() as u64 > MAX_INPUT {
        return None;
    }
    let request: Request = serde_json::from_slice(&input).ok()?;
    let mut ledger = Ledger::open(Path::new(&file)).ok()?;
    let result = ledger.execute(request);
    ledger.close().ok()?;
    let bytes = serde_json::to_vec(&Reply {
        ok: true,
        result: result.ok()?,
    })
    .ok()?;
    (bytes.len() <= MAX_OUTPUT).then_some(bytes)
}

fn main() -> ExitCode {
    let reply = process();
    match io::stdout()
        .lock()
        .write_all(reply.as_deref().unwrap_or(UNAVAILABLE))
    {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}
