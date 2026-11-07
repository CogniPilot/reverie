//! `cleanup/receipts.py` file access: the inputs, the append-only output and
//! its retention. Records come from `reverie_contracts::prune_receipts`.
use reverie_contracts::prune_receipts::{
    self as receipts, Code, Context, Crash, Limits, Receipt, Reference, RetainError,
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
