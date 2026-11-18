use serde_json::json;
use std::{env, path::Path, process::ExitCode};

pub(super) fn run() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    match Path::new(&args[0]).file_name().unwrap().to_str().unwrap() {
        "reverie-install-clis" => {
            eprintln!("synthetic provider installation unavailable");
            ExitCode::FAILURE
        }
        "reverie-kokoro" => {
            eprintln!("synthetic Kokoro started");
            ExitCode::SUCCESS
        }
        "codex" => {
            println!("managed-provider-guard");
            ExitCode::SUCCESS
        }
        "tar" => {
            println!("incomplete archive");
            ExitCode::FAILURE
        }
        "reverie" => {
            let value = |key| env::var(key).unwrap();
            println!(
                "{}",
                json!({
                    "argv": &args[1..],
                    "console": value("REVERIE_DATA_DIR"),
                    "setup": value("REVERIE_OWNER_SETUP"),
                    "username": value("REVERIE_USERNAME"),
                    "credentialLength": value("REVERIE_PASSWORD").len(),
                    "claude": value("CLAUDE_CONFIG_DIR"),
                    "codex": value("CODEX_HOME"),
                })
            );
            ExitCode::SUCCESS
        }
        name => panic!("unexpected startup fixture {name}"),
    }
}
