use crate::{CompanyStore, Error, Result, api};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Request, Response, body::Incoming, server::conn::http1, service::service_fn};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::{convert::Infallible, sync::Arc, time::Duration};
use tokio::{
    net::TcpListener,
    sync::{Semaphore, oneshot},
    task::JoinSet,
    time::Instant,
};

const MAX_BODY: usize = 16 * 1024;
pub async fn serve(
    listener: TcpListener,
    store: Arc<CompanyStore>,
    mut shutdown: oneshot::Receiver<()>,
) -> Result<()> {
    if !listener
        .local_addr()
        .map_err(|_| Error::Storage)?
        .ip()
        .is_loopback()
    {
        return Err(Error::Forbidden);
    }
    let limit = Arc::new(Semaphore::new(8));
    let mut connections = JoinSet::new();
    let outcome = loop {
        let incoming =
            tokio::select! {biased;_=&mut shutdown=>break Ok(()),value=listener.accept()=>value};
        let (stream, peer) = match incoming {
            Ok(pair) => pair,
            Err(_) => break Err(Error::Storage),
        };
        if !peer.ip().is_loopback() {
            continue;
        }
        let Ok(permit) = Arc::clone(&limit).try_acquire_owned() else {
            drop(stream);
            continue;
        };
        let store = Arc::clone(&store);
        connections.spawn(async move {
            let _permit = permit;
            let service = service_fn(move |request| handle(Arc::clone(&store), request));
            let _ = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(Duration::from_secs(2))
                .max_buf_size(32768)
                .max_headers(32)
                .keep_alive(false)
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });
        while connections.try_join_next().is_some() {}
    };
    store.shutdown();
    connections.abort_all();
    let end = Instant::now() + Duration::from_secs(2);
    while !connections.is_empty() {
        if tokio::time::timeout_at(end, connections.join_next())
            .await
            .is_err()
        {
            return Err(Error::PublicationUnconfirmed);
        }
    }
    while store.active_requests() != 0 {
        if Instant::now() >= end {
            return Err(Error::PublicationUnconfirmed);
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    outcome
}
async fn handle(
    store: Arc<CompanyStore>,
    request: Request<Incoming>,
) -> std::result::Result<Response<Full<Bytes>>, Infallible> {
    let result = tokio::time::timeout(Duration::from_secs(5), request_call(store, request))
        .await
        .unwrap_or(Err(Error::PublicationUnconfirmed));
    let (status, value) = api::envelope(result);
    let bytes = serde_json::to_vec(&value)
        .unwrap_or_else(|_| b"{\"success\":false,\"code\":\"REPLY_UNAVAILABLE\"}".to_vec());
    let mut response = Response::new(Full::new(Bytes::from(bytes)));
    *response.status_mut() =
        http::StatusCode::from_u16(status).unwrap_or(http::StatusCode::INTERNAL_SERVER_ERROR);
    response.headers_mut().insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static("application/json"),
    );
    response.headers_mut().insert(
        http::header::CACHE_CONTROL,
        http::HeaderValue::from_static("no-store"),
    );
    Ok(response)
}
async fn request_call(
    store: Arc<CompanyStore>,
    request: Request<Incoming>,
) -> Result<serde_json::Value> {
    if request.uri().query().is_some() {
        return Err(Error::Invalid);
    }
    let token = api::token(request.headers())?.to_owned();
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let mut body = request.into_body();
    let mut bytes = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| Error::Invalid)?;
        if let Some(data) = frame.data_ref() {
            if bytes.len().saturating_add(data.len()) > MAX_BODY {
                return Err(Error::Invalid);
            }
            bytes.extend_from_slice(data);
        }
    }
    let lease = store.begin_request()?;
    tokio::task::spawn_blocking(move || api::call(lease.store(), &method, &path, &token, &bytes))
        .await
        .map_err(|_| Error::PublicationUnconfirmed)?
}

#[cfg(test)]
mod tests;
