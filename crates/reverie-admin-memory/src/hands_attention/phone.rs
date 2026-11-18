use super::Start;
use bytes::Bytes;
use http::{HeaderValue, Request, StatusCode, header};
use http_body_util::{BodyExt, Full, Limited};
use hyper_util::rt::TokioIo;
use reverie_http::{http1_builder, send_response};
use serde::Deserialize;
use serde_json::Value;
use std::{
    net::{Ipv4Addr, SocketAddrV4},
    num::NonZeroU16,
    time::Duration,
};
use tokio::{
    net::TcpStream,
    time::{Instant, timeout_at},
};

const RESPONSE_BYTES: usize = 4096;
const REQUEST_LIMIT: Duration = Duration::from_secs(32);
const DISABLED: &str = "Admin phone wake is not enabled for this instance";

pub(super) struct Phone {
    port: NonZeroU16,
    session: HeaderValue,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Event {
    room_id: String,
    message_id: String,
}

impl Event {
    #[cfg(test)]
    pub(super) fn fixture(room_id: String, message_id: String) -> Self {
        Self {
            room_id,
            message_id,
        }
    }

    fn valid(&self) -> bool {
        [&self.room_id, &self.message_id].into_iter().all(|id| {
            (1..=200).contains(&id.len())
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Poll {
    Active(Option<Event>),
    Disabled,
    Unavailable,
}

impl Phone {
    pub(super) fn bind(start: Start) -> Option<Self> {
        let session = start.session?;
        if start.worker.as_deref() != Some("1")
            || start.parent_session.as_deref() != Some(session.as_str())
            || !(8..=100).contains(&session.len())
            || !session
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return None;
        }
        Some(Self {
            port: loopback_port(&start.endpoint?)?,
            session: HeaderValue::from_str(&session).ok()?,
        })
    }

    pub(super) async fn poll(&self) -> Poll {
        self.exchange().await.unwrap_or(Poll::Unavailable)
    }

    fn request(&self) -> Option<Request<Full<Bytes>>> {
        Request::get("/api/chatrooms/attention")
            .header(header::HOST, format!("127.0.0.1:{}", self.port))
            .header(header::ACCEPT, "application/json")
            .header(header::ACCEPT_ENCODING, "identity")
            .header(header::CONNECTION, "close")
            .header("x-reverie-parent-session", &self.session)
            .body(Full::default())
            .ok()
    }

    async fn exchange(&self) -> Option<Poll> {
        let deadline = Instant::now() + REQUEST_LIMIT;
        let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, self.port.get());
        let socket = timeout_at(deadline, TcpStream::connect(addr))
            .await
            .ok()?
            .ok()?;
        let (mut sender, connection) =
            http1_builder().handshake(TokioIo::new(socket)).await.ok()?;
        let request = self.request()?;
        let driver = tokio::spawn(connection);
        let reply = timeout_at(deadline, async {
            let response = send_response(&mut sender, request, true).await.ok()?;
            let status = response.status();
            if !matches!(status, StatusCode::OK | StatusCode::SERVICE_UNAVAILABLE) {
                return None;
            }
            let body = Limited::new(response.into_body(), RESPONSE_BYTES)
                .collect()
                .await
                .ok()?;
            decode(status, &body.to_bytes())
        })
        .await;
        driver.abort();
        reply.ok().flatten()
    }
}

fn loopback_port(endpoint: &str) -> Option<NonZeroU16> {
    let (scheme, address) = endpoint.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") {
        return None;
    }
    let raw = address.strip_prefix("127.0.0.1:")?;
    let port = raw.strip_suffix('/').unwrap_or(raw);
    if !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    port.parse().ok()
}

fn decode(status: StatusCode, body: &[u8]) -> Option<Poll> {
    let reply: Value = serde_json::from_slice(body).ok()?;
    let success = reply.get("success")?.as_bool()?;
    match status {
        StatusCode::OK if success => {
            let event = reply.get("data")?.as_object()?.get("event");
            let Some(event) = event.filter(|value| !value.is_null()) else {
                return Some(Poll::Active(None));
            };
            let event = Event::deserialize(event).ok()?;
            event.valid().then_some(Poll::Active(Some(event)))
        }
        StatusCode::SERVICE_UNAVAILABLE
            if !success && reply.get("error")?.as_str()? == DISABLED =>
        {
            Some(Poll::Disabled)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests;
