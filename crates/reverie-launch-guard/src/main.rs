use reverie_contracts::launch_guard::{INPUT_LIMIT, Snapshot};
use std::{
    env,
    io::{self, Read, Write},
    process::ExitCode,
};

const REFUSED: u8 = 2;
const HELP: &[u8] = b"Usage: reverie-launch-guard [--help|--example]\nRead bounded fixture JSON from stdin; emit a SYNTHETIC receipt. No live adapter or automatic blocking.\n";
const EXAMPLE: &[u8] = include_bytes!("../../../examples/launch-guard-input.json");
const INVALID: &[u8] = br#"{"code":"GUARD_INPUT_INVALID","result":"REFUSE","schema_version":1}"#;

fn evaluate(out: &mut impl Write) -> io::Result<u8> {
    let mut raw = Vec::new();
    io::stdin()
        .lock()
        .take((INPUT_LIMIT + 1) as u64)
        .read_to_end(&mut raw)?;
    let Ok(snapshot) = Snapshot::decode(&raw) else {
        out.write_all(INVALID)?;
        out.write_all(b"\n")?;
        return Ok(REFUSED);
    };
    let receipt = snapshot.evaluate();
    out.write_all(&receipt.bytes())?;
    out.write_all(b"\n")?;
    Ok(if receipt.passed() { 0 } else { REFUSED })
}

fn run() -> io::Result<u8> {
    let mut args = env::args_os().skip(1);
    let mut out = io::stdout().lock();
    match (args.next(), args.next()) {
        (None, None) => return evaluate(&mut out),
        (Some(arg), None) if arg == "--help" => out.write_all(HELP)?,
        (Some(arg), None) if arg == "--example" => out.write_all(EXAMPLE)?,
        (Some(arg), _) if arg == "--help" || arg == "--example" || arg.is_empty() => {
            return Ok(REFUSED);
        }
        _ => {
            writeln!(io::stderr().lock(), "Unsupported argument")?;
            return Ok(REFUSED);
        }
    }
    Ok(0)
}

fn main() -> ExitCode {
    ExitCode::from(run().unwrap_or(REFUSED))
}
