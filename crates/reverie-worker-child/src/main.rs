//! Fixed in-worker launch-record entry point. No host engine or admission API.
use clap::Parser;
use reverie_host::worker_child::{ChildError, WorkerChildRuntime};
use std::{
    path::PathBuf,
    process::ExitCode,
    time::{Duration, Instant},
};

#[derive(Parser)]
#[command(
    about = "Consume a broker-prepared private worker record and execute its command.",
    long_about = "Consume a broker-prepared record under /home/agent/.reverie-launch, start the fixed worker relays, and replace this process with Bash. This is an in-worker helper; it does not admit host operations or accept engine arguments."
)]
struct Arguments {
    /// Private record prepared by the broker. Consumed once before execution.
    record: PathBuf,
    /// Supervise record mode, publish paired .exit data, and retain the tmux pane.
    #[arg(long, value_name = "EXIT_RECORD")]
    pane_exit: Option<PathBuf>,
}

fn main() -> ExitCode {
    let arguments = Arguments::parse();
    let mut runtime = match WorkerChildRuntime::installed() {
        Ok(runtime) => runtime,
        Err(error) => {
            report(&error);
            return ExitCode::FAILURE;
        }
    };
    let result = match arguments.pane_exit {
        Some(exit) => runtime.execute_pane(&arguments.record, &exit),
        None => runtime.execute_record(&arguments.record),
    };
    let error = match result {
        Err(error) => error,
        Ok(never) => match never {},
    };
    let deadline = Instant::now() + Duration::from_secs(34);
    let settled = runtime.finish(deadline);
    report(&error);
    if let Err(cleanup) = settled {
        report(&cleanup);
        // A failed/late constructor or descriptor finalizer is not a cleanup
        // acknowledgement. Keep its exact retained context alive; no new start,
        // publication or signal retry is admitted. Poll only owned settlement.
        loop {
            std::thread::sleep(Duration::from_millis(50));
            if runtime.finish(Instant::now()).is_ok() {
                break;
            }
        }
    }
    runtime
        .termination_signal()
        .map_or(ExitCode::FAILURE, |signal| {
            ExitCode::from((128 + signal) as u8)
        })
}

fn report(error: &ChildError) {
    let message = format!(
        "Reverie worker unavailable: {error}; record={:?}; cleanup={:?}\n",
        error.record_disposition(),
        error.cleanup_faults()
    );
    let _ = reverie_diagnostics::stderr(message.as_bytes());
}
