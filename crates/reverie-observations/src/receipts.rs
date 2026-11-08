//! `cleanup/receipts.py` file access: the inputs, the append-only output and
//! its retention. Records come from `reverie_contracts::prune_receipts`.
use reverie_contracts::prune_receipts::{
    self as receipts, Code, Context, Crash, Limits, Receipt, Reference, RetainError, python_float,
    python_int,
};
use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

/// The command line, after `argparse`. An empty `--log-dir` or `--context`
/// is `None`, as Python treats it as false.
pub struct Options {
    pub log_dir: Option<PathBuf>,
    pub a1: Vec<PathBuf>,
    pub context: Option<PathBuf>,
    pub out: PathBuf,
    pub max_input_bytes: i64,
    pub limits: Limits,
}

fn os_error<T>(_: T) -> Crash {
    Crash("OSError")
}

/// A text-mode read: an OSError, or a UnicodeDecodeError for invalid UTF-8.
fn read_text(path: &Path) -> Result<String, Crash> {
    String::from_utf8(std::fs::read(path).map_err(os_error)?)
        .map_err(|_| Crash("UnicodeDecodeError"))
}

/// A file name as Python's `os.listdir` str: undecodable bytes become lone
/// surrogates (surrogateescape).
fn name_text(name: &[u8]) -> Vec<u32> {
    let mut text = Vec::new();
    let mut rest = name;
    loop {
        match std::str::from_utf8(rest) {
            Ok(valid) => {
                text.extend(valid.chars().map(u32::from));
                return text;
            }
            Err(error) => {
                let (valid, invalid) = rest.split_at(error.valid_up_to());
                text.extend(String::from_utf8_lossy(valid).chars().map(u32::from));
                let length = error.error_len().unwrap_or(invalid.len());
                text.extend(
                    invalid[..length]
                        .iter()
                        .map(|byte| 0xdc00 + u32::from(*byte)),
                );
                rest = &invalid[length..];
            }
        }
    }
}

/// `*.summary.json` regular files (not links) in the log directory, sorted.
fn summaries(directory: &Path) -> Result<Vec<(Vec<u32>, PathBuf)>, Crash> {
    let suffix = ".summary.json".chars().map(u32::from).collect::<Vec<_>>();
    let mut names = std::fs::read_dir(directory)
        .map_err(os_error)?
        .map(|entry| entry.map(|entry| entry.file_name()).map_err(os_error))
        .collect::<Result<Vec<OsString>, Crash>>()?
        .into_iter()
        .map(|name| (name_text(name.as_bytes()), directory.join(name)))
        .collect::<Vec<_>>();
    names.sort_by(|left, right| left.0.cmp(&right.0));
    names.retain(|(name, path)| name.ends_with(&suffix) && path.is_file() && !path.is_symlink());
    Ok(names)
}

/// `file_ref(path, max_bytes)`: the bytes and their reference, or
/// INPUT_OVERSIZE. A missing or unreadable input is an uncaught OSError.
fn file_ref(path: &Path, limit: i64) -> Result<Result<(Vec<u8>, Reference), Code>, Crash> {
    let oversize = "INPUT_OVERSIZE";
    let size = std::fs::symlink_metadata(path).map_err(os_error)?.len();
    if i128::from(size) > i128::from(limit) {
        return Ok(Err(oversize));
    }
    let mut data = Vec::new();
    File::open(path)
        .and_then(|file| file.take(limit.unsigned_abs() + 1).read_to_end(&mut data))
        .map_err(os_error)?;
    if data.len() as u64 > limit.unsigned_abs() {
        return Ok(Err(oversize));
    }
    let reference = Reference::of(&data);
    Ok(Ok((data, reference)))
}

enum Input {
    Summary(Vec<u32>, PathBuf),
    A1(PathBuf),
}

fn build(input: &Input, context: &Context, limit: i64) -> Result<Result<Receipt, Code>, Crash> {
    let path = match input {
        Input::Summary(_, path) | Input::A1(path) => path,
    };
    let (data, reference) = match file_ref(path, limit)? {
        Ok(read) => read,
        Err(code) => return Ok(Err(code)),
    };
    match input {
        Input::Summary(name, _) => receipts::from_summary(name, &data, &reference, context),
        Input::A1(_) => receipts::from_a1(&data, &reference, context),
    }
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Write `text` to a new file and fsync it (`open(path, "x")`).
fn exclusive(path: &Path, text: &str) -> std::io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()
}

/// Stage, append and fsync the new records. An error leaves the output
/// UNKNOWN.
fn append(out: &Path, new: &[Receipt]) -> std::io::Result<()> {
    let text = new
        .iter()
        .map(|receipt| format!("{}\n", receipt.line))
        .collect::<String>();
    let stage = with_suffix(out, ".stage");
    exclusive(&stage, &text)?;
    let mut output = OpenOptions::new().append(true).create(true).open(out)?;
    output.write_all(text.as_bytes())?;
    output.sync_all()?;
    std::fs::remove_file(stage)
}

/// `retain(...)`: `Ok(None)` is an OSError (output UNKNOWN).
fn retain(out: &Path, limits: Limits, now: f64) -> Result<Option<usize>, Crash> {
    let Ok(raw) = std::fs::read(out) else {
        return Ok(None);
    };
    let text = String::from_utf8(raw).map_err(|_| Crash("UnicodeDecodeError"))?;
    let (dropped, replacement) = match receipts::retain(&text, limits, now) {
        Ok(planned) => planned,
        Err(RetainError::Crash(crash)) => return Err(crash),
        Err(RetainError::Os) => return Ok(None),
    };
    if let Some(replacement) = replacement {
        let temporary = with_suffix(out, ".retain");
        if exclusive(&temporary, &replacement)
            .and_then(|()| std::fs::rename(&temporary, out))
            .is_err()
        {
            return Ok(None);
        }
    }
    Ok(Some(dropped))
}

/// `main(argv)` after argument parsing: the exit code and stdout, or the
/// uncaught exception (exit 1, nothing printed).
pub fn run(options: &Options, now: f64) -> Result<(i32, String), Crash> {
    let context = options.context.as_deref().map(read_text).transpose()?;
    let (context, rejected) = Context::load(context.as_deref())?;
    let mut inputs = Vec::new();
    if let Some(directory) = &options.log_dir {
        inputs.extend(
            summaries(directory)?
                .into_iter()
                .map(|(name, path)| Input::Summary(name, path)),
        );
    }
    inputs.extend(options.a1.iter().cloned().map(Input::A1));
    let have = if options.out.exists() {
        receipts::existing(&read_text(&options.out)?)?
    } else {
        Default::default()
    };
    let (mut new, mut refusals, mut duplicates) = (Vec::<Receipt>::new(), Vec::new(), 0);
    for input in &inputs {
        let receipt = match build(input, &context, options.max_input_bytes)? {
            Ok(receipt) => receipt,
            Err(code) => {
                refusals.push(code);
                continue;
            }
        };
        let prior = have.get(&receipt.id).map(String::as_str).or_else(|| {
            new.iter()
                .find(|other| other.id == receipt.id)
                .map(|other| other.line.as_str())
        });
        match prior {
            Some(prior) if prior == receipt.line => duplicates += 1,
            Some(_) => refusals.push("CONFLICT"),
            None => new.push(receipt),
        }
    }
    let retained = if new.is_empty() || append(&options.out, &new).is_ok() {
        if options.out.exists() {
            retain(&options.out, options.limits, now)?
        } else {
            Some(0)
        }
    } else {
        None
    };
    let line = receipts::summary(
        retained.is_some(),
        new.len(),
        duplicates,
        &refusals,
        &rejected,
        retained.unwrap_or(0),
    );
    let code = match retained {
        None => 3,
        Some(_) if !refusals.is_empty() => 1,
        Some(_) => 0,
    };
    Ok((code, format!("{line}\n")))
}

/// Every option string of `main()`'s parser.
const OPTIONS: [&str; 10] = [
    "-h",
    "--help",
    "--log-dir",
    "--a1",
    "--context",
    "--out",
    "--max-input-bytes",
    "--max-entries",
    "--max-bytes",
    "--max-age-days",
];

/// argparse's negative-number pattern `^-\d+$|^-\d*\.\d+$` (ASCII digits;
/// `$` also matches before one final newline).
fn negative_number(token: &[u8]) -> bool {
    let token = token.strip_suffix(b"\n").unwrap_or(token);
    let Some(body) = token.strip_prefix(b"-") else {
        return false;
    };
    let digits = |part: &[u8]| part.iter().all(u8::is_ascii_digit);
    match body.iter().position(|byte| *byte == b'.') {
        None => !body.is_empty() && digits(body),
        Some(dot) => digits(&body[..dot]) && body.len() > dot + 1 && digits(&body[dot + 1..]),
    }
}

/// argparse's `_parse_optional` for the argument after a value option given
/// without `=`: whether it is that option's value. Anything else starting
/// with `-` is read as an option, so the value option has no argument.
fn is_value(token: &[u8]) -> bool {
    if token.first() != Some(&b'-') {
        return true;
    }
    if OPTIONS.iter().any(|option| option.as_bytes() == token) {
        return false;
    }
    if token.len() == 1 {
        return true;
    }
    let prefix = token.split(|byte| *byte == b'=').next().unwrap_or(token);
    if token.contains(&b'=') && OPTIONS.iter().any(|option| option.as_bytes() == prefix) {
        return false;
    }
    let abbreviation = if token.starts_with(b"--") {
        OPTIONS
            .iter()
            .any(|option| option.as_bytes().starts_with(prefix))
    } else {
        OPTIONS
            .iter()
            .any(|option| option.as_bytes() == &token[..2] || option.as_bytes().starts_with(token))
    };
    !abbreviation && (negative_number(token) || token.contains(&b' '))
}

/// What argparse does first when it reads the arguments left to right.
#[derive(Debug, Eq, PartialEq)]
pub enum Prescan {
    /// A help option is consumed before any error: print help and exit 0.
    Help,
    /// An error raised before any help option: exit 2 with this message.
    Usage(String),
    /// Neither: parse the arguments normally.
    Parse,
}

/// The option a token names: exact, or a unique `--` prefix. `Err` is an
/// ambiguous prefix.
fn option_named(token: &[u8]) -> Result<Option<&'static str>, String> {
    let name = token.split(|byte| *byte == b'=').next().unwrap_or(token);
    if let Some(option) = OPTIONS.iter().find(|option| option.as_bytes() == name) {
        return Ok(Some(option));
    }
    if !token.starts_with(b"--") {
        return Ok(None);
    }
    let matches = OPTIONS
        .iter()
        .filter(|option| option.as_bytes().starts_with(name))
        .copied()
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [] => Ok(None),
        [only] => Ok(Some(only)),
        many => Err(format!(
            "ambiguous option: {} could match {}",
            String::from_utf8_lossy(name),
            many.join(", ")
        )),
    }
}

/// A `-h...` token, as argparse chains short flags: each `h` is another help
/// action, and any other character ends the chain (it becomes an unknown
/// extra), so help runs. An attached `=` value, or a `-` where the next flag
/// would be, is refused before any action runs (`-h=x`, `-hh=`, `-h-x`).
fn short_help(token: &[u8]) -> Prescan {
    let (mut attached, mut rest) = match token.strip_prefix(b"-h=") {
        Some(value) => (true, value),
        None => (false, &token[2..]),
    };
    loop {
        if attached || rest.first() == Some(&b'-') {
            return Prescan::Usage(format!(
                "argument -h/--help: ignored explicit argument '{}'",
                String::from_utf8_lossy(rest)
            ));
        }
        match rest.split_first() {
            Some((b'h', tail)) => match tail.strip_prefix(b"=") {
                Some(value) => (attached, rest) = (true, value),
                None => rest = tail,
            },
            _ => return Prescan::Help,
        }
    }
}

/// argparse's left-to-right consumption: a help option exits 0 as soon as it
/// is reached, while an ambiguous option, a split value read as an option
/// (`--max-entries -1_000`) or a value of the wrong type exits 2 when its
/// option is reached. Unknown options and other arguments are reported only
/// at the end, so they never pre-empt a later help option.
pub fn prescan(args: &[OsString]) -> Prescan {
    let mut at = 0;
    while let Some(token) = args.get(at).map(|arg| arg.as_bytes()) {
        at += 1;
        if token == b"--" {
            return Prescan::Parse;
        }
        if token.first() != Some(&b'-') || token.len() == 1 {
            continue;
        }
        if token.starts_with(b"-h") {
            return short_help(token);
        }
        let option = match option_named(token) {
            Ok(Some(option)) => option,
            Ok(None) => continue,
            Err(message) => return Prescan::Usage(message),
        };
        let attached = token
            .iter()
            .position(|byte| *byte == b'=')
            .map(|equals| &token[equals + 1..]);
        if option == "--help" {
            return match attached {
                None => Prescan::Help,
                Some(value) => Prescan::Usage(format!(
                    "argument -h/--help: ignored explicit argument '{}'",
                    String::from_utf8_lossy(value)
                )),
            };
        }
        let value = match attached {
            Some(value) => value,
            None => match args.get(at).map(|arg| arg.as_bytes()) {
                Some(value) if is_value(value) => {
                    at += 1;
                    value
                }
                _ => return Prescan::Usage(format!("argument {option}: expected one argument")),
            },
        };
        let text = String::from_utf8_lossy(value);
        let (valid, kind) = match option {
            "--max-age-days" => (python_float(&text).is_some(), "float"),
            "--max-input-bytes" | "--max-entries" | "--max-bytes" => {
                (python_int(&text).is_some(), "int")
            }
            _ => (true, ""),
        };
        if !valid {
            return Prescan::Usage(format!("argument {option}: invalid {kind} value: '{text}'"));
        }
    }
    Prescan::Parse
}
