#[cfg(unix)]
#[tokio::main(flavor = "current_thread")]
async fn main() -> std::process::ExitCode {
    use reverie_preview::{Config, DockerLookup, bind, shutdown};
    use std::{ffi::OsStr, path::Path, process::ExitCode, sync::Arc};

    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    let [flag, path] = args.as_slice() else {
        eprintln!("usage: reverie-preview --config PATH");
        return ExitCode::FAILURE;
    };
    if flag != OsStr::new("--config") {
        eprintln!("usage: reverie-preview --config PATH");
        return ExitCode::FAILURE;
    }
    let result = async {
        let config = Config::load(Path::new(path))?;
        let docker = DockerLookup::new(&config);
        bind(config, Arc::new(docker)).await?.run(shutdown()).await
    }
    .await;
    if let Err(error) = result {
        eprintln!("preview service unavailable: {error}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

#[cfg(not(unix))]
fn main() -> std::process::ExitCode {
    eprintln!("preview control sockets require Unix");
    std::process::ExitCode::FAILURE
}
