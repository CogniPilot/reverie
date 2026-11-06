//! Installed process supervision. One child, no replay or restart; the outer
//! service supervisor owns restarting a failed generation.
use crate::{
    channel::Channel,
    process::{FrontChild, InstalledChild},
    session::{self, SessionEnd, ShutdownRequest},
};
use reverie_contracts::route_frames_v2::Signal;
use std::{
    io, num::NonZeroU64, os::unix::process::ExitStatusExt, process::ExitStatus, time::Duration,
};
use tokio::{
    signal::unix::{SignalKind, signal},
    sync::watch,
    task::JoinHandle,
    time::Instant,
};

struct Signals {
    received: watch::Receiver<Option<ShutdownRequest>>,
    task: JoinHandle<()>,
}
struct OwnedSession(JoinHandle<io::Result<SessionEnd>>);
impl Drop for OwnedSession {
    fn drop(&mut self) {
        self.0.abort();
    }
}
impl Signals {
    fn start() -> io::Result<Self> {
        // Register before spawning the child so startup signals are retained.
        let mut term = signal(SignalKind::terminate())?;
        let mut int = signal(SignalKind::interrupt())?;
        let mut hup = signal(SignalKind::hangup())?;
        let (tx, received) = watch::channel(None);
        let task = tokio::spawn(async move {
            let received = tokio::select! {
                _ = term.recv() => Signal::Term,
                _ = int.recv() => Signal::Int,
                _ = hup.recv() => Signal::Hup,
            };
            let _ = tx.send(Some(ShutdownRequest::new(received)));
        });
        Ok(Self { received, task })
    }
}
impl Drop for Signals {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub async fn run(spec: InstalledChild) -> io::Result<i32> {
    let signals = Signals::start()?;
    run_with_signals(spec, signals.received.clone()).await
}
async fn run_with_signals(
    spec: InstalledChild,
    received: watch::Receiver<Option<ShutdownRequest>>,
) -> io::Result<i32> {
    let mut child = FrontChild::spawn(spec)?;
    let channel = match child.channel().and_then(Channel::start) {
        Ok(channel) => channel,
        Err(error) => {
            let _ = child.reap_by(Instant::now()).await;
            return Err(error);
        }
    };
    let (loss, lost) = watch::channel(false);
    let mut session = OwnedSession(tokio::spawn(session::run_supervised(
        channel,
        NonZeroU64::new(1).expect("nonzero"),
        received.clone(),
        lost,
    )));
    tokio::select! {
        status = child.wait() => {
            let _ = loss.send(true);
            finish_exited(&child, &mut session, status?).await
        }
        result = &mut session.0 => settle_session(&mut child, result, &received).await,
        () = wait_deadline(received.clone()) => {
            // This branch is independent of actor work, including a slow bind.
            // KILL is initiated at the captured deadline before awaiting cleanup.
            let _ = loss.send(true);
            let status = child.reap_by(Instant::now()).await?;
            finish_exited(&child, &mut session, status).await
        }
    }
}
async fn settle_session(
    child: &mut FrontChild,
    result: Result<io::Result<SessionEnd>, tokio::task::JoinError>,
    received: &watch::Receiver<Option<ShutdownRequest>>,
) -> io::Result<i32> {
    let outcome = result.map_err(io::Error::other).and_then(|value| value);
    if let Some(status) = child.try_wait()? {
        return Ok(exited_code(status, outcome));
    }
    let _ = child.close_channel();
    let deadline = received.borrow().map_or_else(
        || Instant::now() + Duration::from_secs(2),
        ShutdownRequest::deadline,
    );
    let status = child.reap_by(deadline).await?;
    Ok(exited_code(status, outcome))
}
async fn wait_deadline(mut received: watch::Receiver<Option<ShutdownRequest>>) {
    loop {
        let request = *received.borrow_and_update();
        if let Some(request) = request {
            tokio::time::sleep_until(request.deadline()).await;
            return;
        }
        if received.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}
async fn finish_exited(
    child: &FrontChild,
    session: &mut OwnedSession,
    status: ExitStatus,
) -> io::Result<i32> {
    // Drain already-written frames before forcing the read side shut. Otherwise
    // malformed-frame + exit0 could race past the contract reader as success.
    let outcome = match tokio::time::timeout(Duration::from_secs(2), &mut session.0).await {
        Ok(result) => result,
        Err(_) => {
            let _ = child.close_channel();
            (&mut session.0).await
        }
    }
    .map_err(io::Error::other)
    .and_then(|value| value);
    Ok(exited_code(status, outcome))
}
fn exited_code(status: ExitStatus, outcome: io::Result<SessionEnd>) -> i32 {
    if let Err(error) = outcome {
        let transport_loss = error.kind() == io::ErrorKind::BrokenPipe
            || (!status.success() && error.kind() == io::ErrorKind::UnexpectedEof);
        if !transport_loss {
            eprintln!("reverie-front: generation fault: {error}");
            return 70;
        }
    }
    exit_code(status)
}
fn exit_code(status: ExitStatus) -> i32 {
    status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
}

#[cfg(all(test, target_os = "linux"))]
mod tests;
