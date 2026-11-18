//! Loopback speech transport with immediate busy refusal.
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    Method, Request, Response, StatusCode,
    body::Incoming,
    header::{CONTENT_LENGTH, CONTENT_TYPE},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use reverie_kokoro::{Engine, Result, Voice};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    convert::Infallible,
    path::Path,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{Mutex, OwnedSemaphorePermit, Semaphore},
    time,
};

const MAX_BODY: usize = 8192;
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_CONNECTIONS: usize = 64;
type Reply = Response<Full<Bytes>>;

struct Ready {
    voices: Vec<Voice>,
    engine: Arc<Mutex<Engine>>,
}

pub(super) struct State(OnceLock<Option<Ready>>);

impl State {
    pub(super) fn new() -> Self {
        Self(OnceLock::new())
    }

    pub(super) fn load(&self, directory: &Path) {
        let state = match Engine::load(directory) {
            Ok(engine) => {
                let voices = engine.voices();
                eprintln!("Ready with {} voices", voices.len());
                Some(Ready {
                    voices,
                    engine: Arc::new(Mutex::new(engine)),
                })
            }
            Err(error) => {
                eprintln!("Kokoro could not start: {error}");
                None
            }
        };
        let _ = self.0.set(state);
    }
}

fn reply(status: StatusCode, content_type: &'static str, body: impl Into<Bytes>) -> Reply {
    let mut response = Response::new(Full::new(body.into()));
    *response.status_mut() = status;
    response.headers_mut().insert(
        CONTENT_TYPE,
        hyper::header::HeaderValue::from_static(content_type),
    );
    response
}

fn json_reply(status: StatusCode, value: Value) -> Reply {
    reply(status, "application/json", value.to_string())
}

fn error(status: StatusCode, message: &'static str) -> Reply {
    json_reply(status, json!({"error": message}))
}

fn unavailable(state: &State) -> Reply {
    let message = if state.0.get().is_some() {
        "Kokoro is unavailable"
    } else {
        "Kokoro is loading"
    };
    error(StatusCode::SERVICE_UNAVAILABLE, message)
}

fn health(state: &State) -> Reply {
    let (status, label) = match state.0.get() {
        Some(Some(_)) => (StatusCode::OK, "ready"),
        Some(None) => (StatusCode::SERVICE_UNAVAILABLE, "error"),
        None => (StatusCode::SERVICE_UNAVAILABLE, "loading"),
    };
    json_reply(status, json!({"status": label}))
}

fn voices(state: &State) -> Reply {
    if let Some(Some(ready)) = state.0.get() {
        return json_reply(StatusCode::OK, json!({"voices": ready.voices}));
    }
    json_reply(StatusCode::SERVICE_UNAVAILABLE, json!({"voices": []}))
}

fn select<'a>(
    voices: &'a [Voice],
    payload: &Value,
) -> std::result::Result<&'a Voice, &'static str> {
    if let Some(voice) = payload.get("voice").filter(|v| !v.is_null()) {
        return voices
            .iter()
            .find(|candidate| voice.as_str() == Some(candidate.id()))
            .ok_or("Unknown or unsupported voice");
    }
    let speaker = payload
        .get("speaker")
        .map_or(Some("expert"), Value::as_str)
        .filter(|text| text.chars().count() <= 200)
        .ok_or("Invalid speaker")?;
    let digest = Sha256::digest(speaker.as_bytes());
    let index = u32::from_be_bytes(digest[..4].try_into().expect("SHA-256 prefix")) as usize;
    let english: Vec<_> = voices
        .iter()
        .filter(|voice| voice.language().starts_with("en-"))
        .collect();
    if english.is_empty() {
        return Err("No compatible English voice is installed");
    }
    Ok(english[index % english.len()])
}

async fn request_payload(request: Request<Incoming>) -> std::result::Result<Value, Reply> {
    let length = request
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    if !length.is_some_and(|length| (1..=MAX_BODY).contains(&length)) {
        return Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Speech request is too large or empty",
        ));
    }
    let buffered = time::timeout(
        READ_TIMEOUT,
        Limited::new(request.into_body(), MAX_BODY).collect(),
    )
    .await;
    match buffered {
        Ok(Ok(body)) => serde_json::from_slice::<Value>(&body.to_bytes())
            .ok()
            .filter(Value::is_object)
            .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Expected a JSON object")),
        Ok(Err(_)) => Err(error(
            StatusCode::BAD_REQUEST,
            "Could not read speech request",
        )),
        Err(_) => Err(error(
            StatusCode::REQUEST_TIMEOUT,
            "Speech request timed out",
        )),
    }
}

async fn synthesize(request: Request<Incoming>, state: &State) -> Reply {
    let payload = match request_payload(request).await {
        Ok(payload) => payload,
        Err(reply) => return reply,
    };
    let Some(Some(ready)) = state.0.get() else {
        return unavailable(state);
    };
    let Some(text) = payload
        .get("text")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty() && text.chars().count() <= 600)
    else {
        return error(
            StatusCode::BAD_REQUEST,
            "Text must contain 1 to 600 characters",
        );
    };
    let voice = match select(&ready.voices, &payload) {
        Ok(voice) => voice.clone(),
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    let Ok(mut engine) = Arc::clone(&ready.engine).try_lock_owned() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "Kokoro is busy; try again");
    };
    let text = text.trim().to_owned();
    match tokio::task::spawn_blocking(move || engine.synthesize(&text, voice.id())).await {
        Ok(Ok(Some(wav))) => reply(StatusCode::OK, "audio/wav", wav),
        Ok(Ok(None)) => error(StatusCode::BAD_REQUEST, "Nothing to synthesize"),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "Speech synthesis failed"),
    }
}

async fn dispatch(
    request: Request<Incoming>,
    state: Arc<State>,
) -> std::result::Result<Reply, Infallible> {
    let response = match (
        request.method(),
        request
            .uri()
            .path_and_query()
            .map(hyper::http::uri::PathAndQuery::as_str),
    ) {
        (&Method::GET, Some("/health")) => health(&state),
        (&Method::GET, Some("/voices")) => voices(&state),
        (&Method::POST, Some("/tts")) => synthesize(request, &state).await,
        _ => error(StatusCode::NOT_FOUND, "Not found"),
    };
    Ok(response)
}

pub(super) async fn listen(listener: TcpListener, state: Arc<State>) -> Result<()> {
    let connections = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        let (stream, _) = listener.accept().await?;
        let Ok(permit) = Arc::clone(&connections).try_acquire_owned() else {
            continue;
        };
        tokio::spawn(connection(stream, Arc::clone(&state), permit));
    }
}

async fn connection(stream: TcpStream, state: Arc<State>, _permit: OwnedSemaphorePermit) {
    let _ = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(READ_TIMEOUT)
        .keep_alive(false)
        .serve_connection(
            TokioIo::new(stream),
            service_fn(move |req| dispatch(req, Arc::clone(&state))),
        )
        .await;
}
