//! The fixed hands result route terminates locally, before credentials/backend
//! lookup. Session comes only from the actual bound phone, never event JSON.
use super::{
    body::OfficeBody, native_jobs::NativeValue, request::RequestLifetime, server::Context,
};
use http::{Response, StatusCode};
use std::{sync::Arc, time::Duration};
pub(super) async fn respond(
    context: &Context,
    body: Vec<u8>,
    lifetime: Arc<RequestLifetime>,
) -> Response<OfficeBody> {
    let Some(collector) = context.company.telemetry.as_ref() else {
        return response(false);
    };
    let job = match context.company.native_jobs.telemetry(
        collector.clone(),
        context.session.clone(),
        body,
        lifetime,
    ) {
        Ok(job) => job,
        Err(_) => return response(false),
    };
    // Cancelling this HTTP future leaves the actual thread, collector and real
    // connection seats in Company's registry until its tracked join. No async
    // task cancellation is mistaken for completion of filesystem/SQLite work.
    loop {
        match job.poll() {
            Ok(Some(Ok(NativeValue::Telemetry(accepted)))) => return response(accepted),
            Ok(None) => tokio::time::sleep(Duration::from_millis(5)).await,
            _ => return response(false),
        }
    }
}
fn response(accepted: bool) -> Response<OfficeBody> {
    let mut response = Response::new(OfficeBody::fixed(b""));
    *response.status_mut() = if accepted {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    response
        .headers_mut()
        .insert("content-length", http::HeaderValue::from_static("0"));
    response
        .headers_mut()
        .insert("connection", http::HeaderValue::from_static("close"));
    response
}
