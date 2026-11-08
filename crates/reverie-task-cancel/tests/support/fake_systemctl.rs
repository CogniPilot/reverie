//! A fake `systemctl` for the scope driver tests, built with rustc at test time. It keeps its
//! state in files next to its own executable: it appends each argv to `calls`, writes the
//! environment it was given to `env`, and for `show` prints `show` (after waiting `show.sleep`
//! milliseconds, if present) and exits with `show.code`; for `stop` it exits with `stop.code`.
//! With `show.linger`, `show` first leaves a descendant holding its stdout open that many
//! milliseconds after it exits; with `show.hold`, `show` prints and then keeps running that many
//! milliseconds with its stdout closed.
use std::{env, fs, io::Write, path::Path, process::ExitCode, thread, time::Duration};

fn code(path: &Path) -> u8 {
    fs::read_to_string(path).ok().and_then(|text| text.trim().parse().ok()).unwrap_or(0)
}

fn main() -> ExitCode {
    let exe = env::current_exe().unwrap();
    let dir = exe.parent().unwrap();
    let args: Vec<String> = env::args().skip(1).collect();
    if let [flag, ms] = args.as_slice()
        && flag == "--linger"
    {
        thread::sleep(Duration::from_millis(ms.parse().unwrap()));
        return ExitCode::SUCCESS;
    }
    let mut calls = fs::OpenOptions::new().create(true).append(true).open(dir.join("calls")).unwrap();
    writeln!(calls, "{}", args.join(" ")).unwrap();
    let mut seen: Vec<String> = env::vars().map(|(key, value)| format!("{key}={value}")).collect();
    seen.sort();
    fs::write(dir.join("env"), seen.join("\n")).unwrap();
    match args.get(1).map(String::as_str) {
        Some("show") => {
            if let Ok(text) = fs::read_to_string(dir.join("show.linger")) {
                std::process::Command::new(&exe).args(["--linger", text.trim()]).spawn().unwrap();
            }
            if let Ok(text) = fs::read_to_string(dir.join("show.sleep")) {
                thread::sleep(Duration::from_millis(text.trim().parse().unwrap()));
            }
            std::io::stdout().write_all(&fs::read(dir.join("show")).unwrap_or_default()).unwrap();
            if let Ok(text) = fs::read_to_string(dir.join("show.hold")) {
                use std::os::unix::process::CommandExt;
                std::io::stdout().flush().unwrap();
                let error = std::process::Command::new(&exe)
                    .args(["--linger", text.trim()])
                    .stdout(std::process::Stdio::null())
                    .exec();
                panic!("exec failed: {error}");
            }
            ExitCode::from(code(&dir.join("show.code")))
        }
        Some("stop") => ExitCode::from(code(&dir.join("stop.code"))),
        _ => ExitCode::from(64),
    }
}
