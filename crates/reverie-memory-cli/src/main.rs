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
    /// Use fixed installed context DATA. Actual caller authority remains at the API.
    #[arg(long, conflicts_with_all=["instance","initialize"], requires="expected_context")]
    installed_context: bool,
    /// Exact installed-context byte fingerprint supplied by the fixed MCP bootstrap.
    #[arg(long, requires = "installed_context")]
    expected_context: Option<String>,
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
    fn finalized<T>(result: Result<T>, closed: Result<()>) -> Result<T> {
        match (result, closed) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
            (Err(primary), Err(secondary)) => {
                let mut text = primary.0.codepoints().to_vec();
                text.extend("; finalization: ".chars().map(u32::from));
                text.extend_from_slice(secondary.0.codepoints());
                Err(Self(
                    MetadataText::from_python_text(
                        reverie_core::PythonText::try_new(text).expect("checked error text"),
                    ),
                    if secondary.1 >= 128 {
                        secondary.1
                    } else {
                        primary.1
                    },
                ))
            }
        }
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
    if arguments.installed_context {
        return Ok(arguments);
    }
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
    let mut installed = None;
    let result = (|| {
        if arguments.installed_context {
            let context = reverie_host::memory_context::InstalledContext::capture()
                .map_err(Failure::display)?
                .ok_or_else(|| Failure::text("installed memory context unavailable"))?;
            installed = Some(context);
            let context = installed.as_ref().expect("adopted installed context");
            if arguments.expected_context.as_deref() != Some(context.fingerprint().as_str()) {
                return Err(Failure::text("installed memory context changed"));
            }
        }
        request::run(
            &arguments,
            installed
                .as_ref()
                .map(reverie_host::memory_context::InstalledContext::data),
        )
    })();
    let closed = installed
        .as_mut()
        .map_or(Ok(()), |context| context.close().map_err(Failure::display));
    let result = Failure::finalized(result, closed);
    // Namespace close synchronously consumes every local descriptor once. A
    // sticky negative outcome is not a constructor that could later finish.
    Failure::finalized(result, namespace.close().map_err(Failure::display))
}
fn settle<E: std::fmt::Display>(
    mut shutdown: impl FnMut() -> reverie_core::shutdown::ShutdownStatus<E>,
) -> std::result::Result<(), E> {
    use reverie_core::shutdown::ShutdownStatus;
    let mut reported = false;
    loop {
        match shutdown() {
            ShutdownStatus::Complete => return Ok(()),
            ShutdownStatus::Refused(error) => return Err(error),
            ShutdownStatus::Pending(error) => {
                if !reported {
                    let _ = reverie_diagnostics::stderr(
                        format!("Reverie memory cleanup pending: {error}\n").as_bytes(),
                    );
                    reported = true;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
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
