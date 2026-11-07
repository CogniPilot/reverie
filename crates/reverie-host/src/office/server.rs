use super::{
    Company, OfficeError, Result, global_slots, io_timeout::IdleIo, proxy, socket::SocketEntry,
};
use http::StatusCode;
use hyper::{server::conn::http1, service::service_fn};
use hyper_util::rt::TokioIo;
use reverie_core::ids::ProfileSessionId;
use std::{
    convert::Infallible,
    future::{Future, poll_fn},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    task::Poll,
    time::{Duration, Instant},
};
use tokio::{net::UnixStream, sync::Semaphore, task::JoinSet};
pub(super) struct Context {
    pub(super) company: Arc<Company>,
    pub(super) session: ProfileSessionId,
    closing: Arc<AtomicBool>,
    tokens: Mutex<(f64, Instant)>,
    local: Arc<Semaphore>,
    live_requests: Arc<AtomicUsize>,
}
impl Context {
    pub(super) fn new(
        company: Arc<Company>,
        session: ProfileSessionId,
        closing: Arc<AtomicBool>,
        live_requests: Arc<AtomicUsize>,
    ) -> Arc<Self> {
        Arc::new(Self {
            company,
            session,
            closing,
            tokens: Mutex::new((40., Instant::now())),
            local: Arc::new(Semaphore::new(4)),
            live_requests,
        })
    }
    fn closing(&self) -> bool {
        self.closing.load(Ordering::Acquire)
            || self.company.closing.load(Ordering::Acquire)
            || self.company.engine.cancellation().is_cancelled()
    }
    fn take_token(&self) -> bool {
        let Ok(mut state) = self.tokens.lock() else {
            return false;
        };
        let now = Instant::now();
        state.0 = (state.0 + now.duration_since(state.1).as_secs_f64() * 10.).min(40.);
        state.1 = now;
        if state.0 < 1. {
            return false;
        }
        state.0 -= 1.;
        true
    }
}
type NativeListener = std::os::unix::net::UnixListener;
pub(super) type SpawnPayload = Arc<Mutex<Option<PreparedOffice>>>;
pub(super) struct PreparedOffice {
    runtime: tokio::runtime::Runtime,
    listener: NativeListener,
    socket: SocketEntry,
    context: Arc<Context>,
}
pub(super) fn runtime() -> Result<tokio::runtime::Runtime> {
    #[cfg(test)]
    super::test_hooks::fail(super::test_hooks::Failure::Runtime)?;
    Ok(tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?)
}
impl PreparedOffice {
    pub(super) fn new(
        runtime: tokio::runtime::Runtime,
        listener: NativeListener,
        socket: SocketEntry,
        context: Arc<Context>,
    ) -> Self {
        Self {
            runtime,
            listener,
            socket,
            context,
        }
    }
    fn run(mut self) -> Result<()> {
        // AsyncFd borrows the actual listener. Registration failure cannot
        // consume/drop its sole descriptor before our checked finalizer.
        let result = self.runtime.block_on(serve(&self.listener, self.context));
        let closed = close_listener(self.listener);
        let removed = self.socket.remove().map_err(super::socket::socket_error);
        super::finalized(result, super::finalized(closed, removed))
    }
    fn close(mut self) -> Result<()> {
        super::finalized(
            close_listener(self.listener),
            self.socket.remove().map_err(super::socket::socket_error),
        )
    }
}
pub(super) fn spawn(
    payload: &SpawnPayload,
) -> std::io::Result<std::thread::JoinHandle<Result<()>>> {
    #[cfg(test)]
    super::test_hooks::fail(super::test_hooks::Failure::Spawn)?;
    let payload = Arc::clone(payload);
    std::thread::Builder::new()
        .name("reverie-office".into())
        .spawn(move || {
            let prepared = payload
                .lock()
                .map_err(|_| OfficeError::Unconfirmed)?
                .take()
                .ok_or(OfficeError::Unconfirmed)?;
            prepared.run()
        })
}
pub(super) fn cleanup_payload(payload: &SpawnPayload) -> Result<()> {
    let prepared = payload
        .lock()
        .map_err(|_| OfficeError::Unconfirmed)?
        .take()
        .ok_or(OfficeError::Unconfirmed)?;
    prepared.close()
}
pub(super) fn close_listener(listener: NativeListener) -> Result<()> {
    let descriptor: std::os::fd::OwnedFd = listener.into();
    crate::native::close(std::fs::File::from(descriptor)).map_err(|_| OfficeError::Unconfirmed)
}
async fn accept(readiness: &crate::native::OfficeListenerReady<'_>) -> Result<UnixStream> {
    let stream = readiness.accept().await?;
    if let Err(error) = stream.set_nonblocking(true) {
        let descriptor: std::os::fd::OwnedFd = stream.into();
        let closed = crate::native::close(std::fs::File::from(descriptor))
            .map_err(|_| OfficeError::Unconfirmed);
        return super::finalized(Err(error.into()), closed);
    }
    UnixStream::from_std(stream).map_err(|_| OfficeError::Unconfirmed)
}
async fn serve(listener: &NativeListener, context: Arc<Context>) -> Result<()> {
    let readiness = crate::native::OfficeListenerReady::register(listener)?;
    let mut requests = JoinSet::new();
    let mut failed = false;
    while !context.closing() {
        while let Some(result) = requests.try_join_next() {
            failed |= result.is_err();
        }
        match tokio::time::timeout(Duration::from_millis(50), accept(&readiness)).await {
            Ok(Ok(stream)) => admit(stream, &context, &mut requests),
            Ok(Err(error)) => {
                requests.abort_all();
                while requests.join_next().await.is_some() {}
                return Err(error);
            }
            Err(_) => (),
        }
    }
    // Cancellation drops only these actual async connection futures/sockets.
    // It cannot promise that an upstream server rolled back an accepted effect.
    requests.abort_all();
    while let Some(result) = requests.join_next().await {
        failed |= result.is_err_and(|error| !error.is_cancelled());
    }
    if failed {
        Err(OfficeError::Unconfirmed)
    } else {
        Ok(())
    }
}
fn admit(stream: UnixStream, context: &Arc<Context>, requests: &mut JoinSet<()>) {
    let Ok(local) = Arc::clone(&context.local).try_acquire_owned() else {
        return;
    };
    let Ok(global) = global_slots().try_acquire_owned() else {
        return;
    };
    let context = Arc::clone(context);
    let lifetime =
        super::request::RequestLifetime::new(local, global, context.live_requests.clone());
    requests.spawn(async move {
        let _owned = lifetime.clone();
        let service_context = Arc::clone(&context);
        let service = service_fn(move |request| {
            handle(request, Arc::clone(&service_context), lifetime.clone())
        });
        let mut builder = http1::Builder::new();
        builder
            .keep_alive(false)
            .max_headers(99)
            .max_buf_size(100 * 65536 + 2);
        let connection = builder.serve_connection(
            TokioIo::new(IdleIo::new(stream, Duration::from_secs(15))),
            service,
        );
        until_close(Box::pin(connection), &context).await;
    });
}
async fn handle(
    request: http::Request<hyper::body::Incoming>,
    context: Arc<Context>,
    lifetime: Arc<super::request::RequestLifetime>,
) -> std::result::Result<http::Response<super::body::OfficeBody>, Infallible> {
    let response = if context.closing() {
        proxy::refusal(StatusCode::SERVICE_UNAVAILABLE)
    } else if !context.take_token() {
        proxy::refusal(StatusCode::TOO_MANY_REQUESTS)
    } else {
        proxy::handle(request, context, lifetime).await
    };
    Ok(response)
}
async fn until_close<F: Future>(mut future: Pin<Box<F>>, context: &Context) {
    let mut timer = Box::pin(tokio::time::sleep(Duration::from_millis(50)));
    poll_fn(|cx| {
        if context.closing() {
            return Poll::Ready(());
        }
        if future.as_mut().poll(cx).is_ready() {
            return Poll::Ready(());
        }
        if timer.as_mut().poll(cx).is_ready() {
            timer
                .as_mut()
                .reset(tokio::time::Instant::now() + Duration::from_millis(50));
            let _ = timer.as_mut().poll(cx);
        }
        Poll::Pending
    })
    .await;
}
