//! Installed memory bridge. No arbitrary database, SQL, model or owner selector.
mod journal;
mod request;
use clap::Parser;
use reverie_contracts::{memory_cli::MemoryReply, storage_identity::MetadataText};
use reverie_host::memory_namespace::MemoryNamespace;
use std::{
    io::{self, Write},
    path::PathBuf,
    process::ExitCode,
    time::Duration,
};

#[derive(Parser)]
#[command(
    about = "Screen text, read explicitly scoped memory, or save through the authenticated Office journal.",
    long_about = "Read one JSON screen/recall/remember request from stdin. Instance selection is installed bootstrap configuration, never a request field. Recall is read-only and requires explicit initialization. Remember writes only through the supported Office journal API; this tool does not grant session or source access."
)]
struct Arguments {
    /// Selected instance configuration; alternatively REVERIE_INSTANCE_CONFIG.
    #[arg(long)]
    instance: Option<PathBuf>,
    /// Explicitly initialize the selected scope; never performed by recall.
    #[arg(long)]
    initialize: bool,
    /// Project scope for explicit initialization; otherwise private memory.
    #[arg(long, requires = "initialize")]
    project: Option<String>,
}
struct Failure(MetadataText, u8);
impl Failure {
    fn text(message: &str) -> Self {
        Self(MetadataText::from_scalar_text(message), 1)
    }
    fn display(error: impl std::fmt::Display) -> Self {
        Self::text(&error.to_string())
    }
}
type Result<T> = std::result::Result<T, Failure>;
fn main() -> ExitCode {
    let arguments = Arguments::parse();
    let result = selected(arguments).and_then(run);
    match result {
        Ok(reply) => write_reply(&reply, false),
        Err(error) => {
            let _ = write_reply(&MemoryReply::error(&error.0), true);
            ExitCode::from(error.1)
        }
    }
}
fn selected(mut arguments: Arguments) -> Result<Arguments> {
    if arguments.instance.is_none() {
        arguments.instance = std::env::var_os("REVERIE_INSTANCE_CONFIG")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
    }
    if arguments.instance.is_none() {
        return Err(Failure::text(
            "select an instance with --instance or REVERIE_INSTANCE_CONFIG",
        ));
    }
    Ok(arguments)
}
fn run(arguments: Arguments) -> Result<MemoryReply> {
    let mut namespace = MemoryNamespace::capture_current().map_err(Failure::display)?;
    let result = request::run(&arguments);
    if let Err(error) = namespace.close() {
        retain(|| namespace.close().is_ok(), &error.to_string());
        return Err(Failure::text(
            "memory namespace finalization was unconfirmed",
        ));
    }
    result
}
fn retain(mut settled: impl FnMut() -> bool, message: &str) {
    let _ = reverie_diagnostics::stderr(
        format!("Reverie memory cleanup pending: {message}\n").as_bytes(),
    );
    loop {
        std::thread::sleep(Duration::from_millis(50));
        if settled() {
            break;
        }
    }
}
fn write_reply(reply: &MemoryReply, error: bool) -> ExitCode {
    let mut output: Box<dyn Write> = if error {
        Box::new(io::stderr().lock())
    } else {
        Box::new(io::stdout().lock())
    };
    if output
        .write_all(reply.as_json())
        .and_then(|()| output.write_all(b"\n"))
        .and_then(|()| output.flush())
        .is_ok()
    {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
