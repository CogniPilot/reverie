use super::*;
use std::{ffi::OsString, path::PathBuf};

fn spec(name: &str) -> InstalledChild {
    InstalledChild {
        node: std::env::var_os("REVERIE_TEST_NODE")
            .expect("explicit pinned Node")
            .into(),
        entrypoint: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
        arguments: Vec::<OsString>::new(),
    }
}
#[test]
#[ignore = "requires explicit pinned Node; actual child exit and forced signal deadline"]
fn one_child_exit_status_is_preserved_and_an_unresponsive_child_is_killed_and_reaped() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(qualify_exit());
}
async fn qualify_exit() {
    let (_signals, rx) = watch::channel(None);
    assert_eq!(
        run_with_signals(spec("exit-child.mjs"), rx).await.unwrap(),
        17
    );
    for _ in 0..4 {
        let (_signals, rx) = watch::channel(None);
        assert_eq!(
            run_with_signals(spec("bad-frame-child.mjs"), rx)
                .await
                .unwrap(),
            70
        );
    }
    for (mode, expected) in [("error", 17), ("signal", 137), ("success", 70)] {
        let mut child = spec("partial-frame-child.mjs");
        child.arguments.push(mode.into());
        let (_signals, rx) = watch::channel(None);
        assert_eq!(run_with_signals(child, rx).await.unwrap(), expected);
    }
    let (signals, rx) = watch::channel(None);
    let child = tokio::spawn(run_with_signals(spec("wait-child.mjs"), rx));
    let request = ShutdownRequest::new(Signal::Term);
    signals.send(Some(request)).unwrap();
    // Test the actual standard 10-second TS force-exit + 2-second front window.
    assert_eq!(child.await.unwrap().unwrap(), 137);
    assert!(Instant::now() >= request.deadline());
}
