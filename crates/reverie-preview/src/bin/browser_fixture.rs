#[cfg(unix)]
#[tokio::main(flavor = "current_thread")]
async fn main() -> std::io::Result<()> {
    use std::{io, path::PathBuf};
    let path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("fixture directory required"))?;
    reverie_preview::browser_fixture::run(&path).await
}

#[cfg(not(unix))]
fn main() -> std::process::ExitCode {
    eprintln!("preview control sockets require Unix");
    std::process::ExitCode::FAILURE
}
