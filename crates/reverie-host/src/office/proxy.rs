use super::{
    Company, OfficeError, Result,
    body::{Driver, OfficeBody},
    credentials,
    io_timeout::IdleIo,
    policy::{self, Route},
    server::Context,
};
use bytes::Bytes;
use http::{Request, Response, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;
use std::{
    future::{Future, poll_fn},
    sync::Arc,
    task::Poll,
    time::Duration,
};
use tokio::net::TcpStream;
pub(super) async fn handle(
    mut request: Request<Incoming>,
    context: Arc<Context>,
) -> Response<OfficeBody> {
    let policy = match policy::classify(&request) {
        Ok(policy) => policy,
        Err(status) => return refusal(status),
    };
    let length = policy.length;
    // Read the whole admitted body before a known unavailable OPS refusal.
    // One absolute15s bound prevents a slow sender from extending that window.
    let read = read_body(request.body_mut(), length);
    let mut body = match tokio::time::timeout(Duration::from_secs(15), read).await {
        Ok(Ok(body)) => body,
        _ => return refusal(StatusCode::BAD_REQUEST),
    };
    let hooks = match policy.route {
        Route::Forward { hooks } => hooks,
        Route::PlanDecision => {
            body = match plan_decision(&context, &request, &body) {
                Ok(body) => body,
                Err(_) => return refusal(StatusCode::FORBIDDEN),
            };
            false
        }
        Route::OpsUnavailable | Route::Unavailable => {
            return refusal(StatusCode::SERVICE_UNAVAILABLE);
        }
    };
    let headers = match credentials::headers(
        &context.company,
        &context.session,
        request.headers(),
        hooks,
        &body,
    ) {
        Ok(headers) => headers,
        Err(_) => return refusal(StatusCode::FORBIDDEN),
    };
    let (mut parts, _) = request.into_parts();
    parts.headers = headers;
    let request = Request::from_parts(parts, Full::new(Bytes::from(body)));
    match forward(&context.company, request).await {
        Ok(response) => response,
        Err(_) => refusal(StatusCode::BAD_GATEWAY),
    }
}
fn plan_decision(context: &Context, request: &Request<Incoming>, body: &[u8]) -> Result<Vec<u8>> {
    let decision = reverie_contracts::office_plan::PlanDecision::decode(
        request.method().as_str(),
        request.uri().path(),
        request.uri().query().is_some(),
        body,
    )
    .map_err(|_| OfficeError::Refused)?;
    let capability =
        crate::native::office_plan_capability(&context.company.root, &context.session, &decision)
            .map_err(|_| OfficeError::Refused)?;
    decision
        .attach_capability(&context.session, &capability)
        .map_err(|_| OfficeError::Refused)
}
async fn read_body(body: &mut Incoming, length: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(length.min(65536));
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| OfficeError::Refused)?;
        let data = frame.into_data().map_err(|_| OfficeError::Refused)?;
        if data.len() > length.saturating_sub(bytes.len()) {
            return Err(OfficeError::Refused);
        }
        bytes.extend_from_slice(&data);
    }
    if bytes.len() != length {
        return Err(OfficeError::Refused);
    }
    Ok(bytes)
}
async fn forward(company: &Company, request: Request<Full<Bytes>>) -> Result<Response<OfficeBody>> {
    let address = *company
        .address
        .read()
        .map_err(|_| OfficeError::Unconfirmed)?;
    let socket = tokio::time::timeout(Duration::from_secs(310), TcpStream::connect(address))
        .await
        .map_err(|_| OfficeError::Refused)??;
    let (mut sender, connection) = reverie_http::http1_builder()
        .handshake(TokioIo::new(IdleIo::new(socket, Duration::from_secs(310))))
        .await
        .map_err(|_| OfficeError::Refused)?;
    let mut driver = Driver::new(connection);
    let response = reverie_http::send_response(&mut sender, request, true);
    let mut response = std::pin::pin!(response);
    let response = poll_fn(|cx| {
        let driven = driver.poll(cx);
        match response.as_mut().poll(cx) {
            Poll::Ready(result) => Poll::Ready(result.map_err(|_| OfficeError::Refused)),
            Poll::Pending if matches!(driven, Poll::Ready(true)) => {
                Poll::Ready(Err(OfficeError::Refused))
            }
            Poll::Pending => Poll::Pending,
        }
    })
    .await?;
    let (mut parts, body) = response.into_parts();
    for name in ["set-cookie", "connection", "transfer-encoding"] {
        parts.headers.remove(name);
    }
    parts
        .headers
        .insert("connection", http::HeaderValue::from_static("close"));
    Ok(Response::from_parts(
        parts,
        OfficeBody::stream(body, driver),
    ))
}
pub(super) fn refusal(status: StatusCode) -> Response<OfficeBody> {
    let mut response = Response::new(OfficeBody::fixed(
        b"{\"success\":false,\"errorCode\":\"OFFICE_UNAVAILABLE\"}",
    ));
    *response.status_mut() = status;
    response.headers_mut().insert(
        "content-type",
        http::HeaderValue::from_static("application/json"),
    );
    response
        .headers_mut()
        .insert("connection", http::HeaderValue::from_static("close"));
    response
}
