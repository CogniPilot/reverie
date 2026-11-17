//! Isolated process fixture; never included in the default runtime package.
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args
        .first()
        .is_some_and(|arg| arg.starts_with("--query-gpu="))
    {
        return gpu_provider(&args);
    }
    let role = if std::env::var_os("REVERIE_MODEL_PORT").is_some() {
        "relay"
    } else if args.first().is_some_and(|arg| arg == "--output") {
        "telemetry"
    } else if args.first().is_some_and(|arg| arg == "--model") {
        "model"
    } else {
        "website"
    };
    let state = PathBuf::from(std::env::var_os("REVERIE_FIXTURE_STATE").unwrap());
    if role == "model" {
        fs::write(state.join("model.args"), args.join("\n")).unwrap();
    }
    if role == "website" {
        fs::write(
            state.join("telemetry-path"),
            std::env::var("REVERIE_GPU_STATUS_FILE").unwrap(),
        )
        .unwrap();
    }
    // A sibling may fail and trigger shutdown at any instruction. Publish the
    // complete observation only after its companion records are ready.
    let temporary = state.join(format!("{role}.pid.tmp"));
    fs::write(&temporary, std::process::id().to_string()).unwrap();
    fs::rename(temporary, state.join(format!("{role}.pid"))).unwrap();
    if std::env::var("REVERIE_FIXTURE_FAIL").is_ok_and(|fail| fail == role) {
        return ExitCode::from(42);
    }
    loop {
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn gpu_provider(args: &[String]) -> ExitCode {
    use std::io::Write;
    assert_eq!(
        args,
        [
            "--query-gpu=name,utilization.gpu,memory.used,memory.total",
            "--format=csv,noheader,nounits",
        ]
    );
    let program = std::env::current_exe().unwrap();
    if program.with_extension("hang").exists() {
        std::thread::sleep(Duration::from_secs(30));
    }
    if program.with_extension("fail").exists() {
        return ExitCode::from(9);
    }
    let csv = fs::read(program.with_extension("csv")).unwrap();
    std::io::stdout().write_all(&csv).unwrap();
    ExitCode::SUCCESS
}
