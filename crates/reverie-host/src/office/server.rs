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
        atomic::{AtomicBool, Ordering},
    },
    task::Poll,
    time::{Duration, Instant},
};
use tokio::{
    net::{UnixListener, UnixStream},
    sync::Semaphore,
    task::JoinSet,
};
pub(super) struct Context {
    pub(super) company: Arc<Company>,
    pub(super) session: ProfileSessionId,
    closing: Arc<AtomicBool>,
    tokens: Mutex<(f64, Instant)>,
    local: Arc<Semaphore>,
}
impl Context {
    pub(super) fn new(
        company: Arc<Company>,
        session: ProfileSessionId,
        closing: Arc<AtomicBool>,
    ) -> Arc<Self> {
        Arc::new(Self {
            company,
            session,
            closing,
            tokens: Mutex::new((40., Instant::now())),
            local: Arc::new(Semaphore::new(4)),
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
pub(super) fn run(
    listener: std::os::unix::net::UnixListener,
    mut socket: SocketEntry,
    context: Arc<Context>,
) -> Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(async {
        let listener = UnixListener::from_std(listener)?;
        let result = serve(&listener, context).await;
        let closed = listener
            .into_std()
            .map_err(OfficeError::Io)
            .and_then(|listener| {
                let descriptor: std::os::fd::OwnedFd = listener.into();
                crate::native::close(std::fs::File::from(descriptor))
                    .map_err(|_| OfficeError::Unconfirmed)
            });
        super::finalized(result, closed)
    });
    let removed = socket.remove();
    super::finalized(result, removed)
}
async fn serve(listener: &UnixListener, context: Arc<Context>) -> Result<()> {
    let mut requests = JoinSet::new();
    let mut failed = false;
    while !context.closing() {
        while let Some(result) = requests.try_join_next() {
            failed |= result.is_err();
        }
        match tokio::time::timeout(Duration::from_millis(50), listener.accept()).await {
            Ok(Ok((stream, _))) => admit(stream, &context, &mut requests),
            Ok(Err(error)) => {
                requests.abort_all();
                while requests.join_next().await.is_some() {}
                return Err(error.into());
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
    requests.spawn(async move {
        let _owned = (local, global);
        let service_context = Arc::clone(&context);
        let service = service_fn(move |request| handle(request, Arc::clone(&service_context)));
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
) -> std::result::Result<http::Response<super::body::OfficeBody>, Infallible> {
    let response = if context.closing() {
        proxy::refusal(StatusCode::SERVICE_UNAVAILABLE)
    } else if !context.take_token() {
        proxy::refusal(StatusCode::TOO_MANY_REQUESTS)
    } else {
        proxy::handle(request, context).await
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
