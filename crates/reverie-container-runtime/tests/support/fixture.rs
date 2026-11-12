//! Isolated process fixture; never included in the default runtime package.
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let role = if std::env::var("REVERIE_CONTAINER_RELAY").as_deref() == Ok("1") {
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
