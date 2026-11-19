//! Loopback speech transport. The Office routes own room identity and turns.
mod cache;
mod upload;

use crate::{Result, Whisper, piper::Piper};
use bytes::Bytes;
use cache::Cache;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    Method, Request, Response, StatusCode,
    body::Incoming,
    header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{OwnedSemaphorePermit, Semaphore},
    time,
};

const LIMIT: usize = 10 * 1024 * 1024;
const BODY_TIMEOUT: Duration = Duration::from_secs(10);
type Reply = Response<Full<Bytes>>;

pub struct Configuration {
    pub whisper: Whisper,
    pub piper: PathBuf,
    pub models: PathBuf,
    pub voice: String,
    pub scratch: PathBuf,
    pub audio_ttl: Duration,
}

struct State {
    whisper: Whisper,
    piper: Piper,
    cache: Mutex<Cache>,
}

pub async fn serve(socket: TcpListener, config: Configuration) -> Result<()> {
    if !socket.local_addr()?.ip().is_loopback() {
        return Err("Speech listener must use loopback".into());
    }
    let audio = Cache::new(config.audio_ttl, config.models.join("audio"));
    let piper = Piper::new(config.piper, config.models, config.voice, config.scratch)?;
    let state = Arc::new(State {
        whisper: config.whisper,
        piper,
        cache: Mutex::new(audio),
    });
    let permits = Arc::new(Semaphore::new(8));
    loop {
        let (stream, _) = socket.accept().await?;
        if let Ok(permit) = Arc::clone(&permits).try_acquire_owned() {
            tokio::spawn(connection(stream, Arc::clone(&state), permit));
        }
    }
}

async fn connection(stream: TcpStream, state: Arc<State>, _permit: OwnedSemaphorePermit) {
    let _ = http1::Builder::new()
        .timer(TokioTimer::new())
        .keep_alive(false)
        .header_read_timeout(BODY_TIMEOUT)
        .serve_connection(
            TokioIo::new(stream),
            service_fn(move |req| dispatch(req, Arc::clone(&state))),
        )
        .await;
}

async fn dispatch(
    req: Request<Incoming>,
    state: Arc<State>,
) -> std::result::Result<Reply, Infallible> {
    let reply = match (req.method(), req.uri().path()) {
        (&Method::GET, "/health") => state.health(),
        (&Method::GET, "/voices") => json_reply(
            StatusCode::OK,
            json!({"voices": state.piper.voices(), "default": state.piper.default()}),
        ),
        (&Method::GET, path) if path.starts_with("/audio/") => state.audio(&path[7..]),
        (&Method::POST, "/stt") => stt(req, &state).await,
        (&Method::POST, "/tts") => tts(req, &state).await,
        _ => error(StatusCode::NOT_FOUND, "No speech resource"),
    };
    Ok(reply)
}

impl State {
    fn health(&self) -> Reply {
        let status = |ready| if ready { "ready" } else { "loading" };
        json_reply(
            StatusCode::OK,
            json!({"status": "ok",
            "stt": status(self.whisper.ready()), "tts": status(self.piper.ready())}),
        )
    }

    fn audio(&self, id: &str) -> Reply {
        let Ok(mut cache) = self.cache.lock() else {
            return unavailable();
        };
        match cache.get(id) {
            Some(bytes) => response(StatusCode::OK, "audio/wav", bytes),
            None => error(StatusCode::NOT_FOUND, "No such audio"),
        }
    }

    fn retain(&self, bytes: Bytes, started: Instant) -> Reply {
        let Ok(mut cache) = self.cache.lock() else {
            return unavailable();
        };
        match cache.put(bytes) {
            Ok(id) => json_reply(
                StatusCode::OK,
                json!({
                    "id": id, "audio_url": format!("/audio/{id}.wav"), "tts_ms": started.elapsed().as_millis()
                }),
            ),
            Err(_) => unavailable(),
        }
    }
}

async fn payload(request: Request<Incoming>, bound: usize) -> std::result::Result<Bytes, Reply> {
    let length = request
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    if length.is_some_and(|size| size == 0 || size > bound) {
        return Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Speech request is too large or empty",
        ));
    }
    match time::timeout(
        BODY_TIMEOUT,
        Limited::new(request.into_body(), bound).collect(),
    )
    .await
    {
        Ok(Ok(body)) => {
            let bytes = body.to_bytes();
            if bytes.is_empty() {
                Err(error(StatusCode::BAD_REQUEST, "Speech request is empty"))
            } else {
                Ok(bytes)
            }
        }
        Ok(Err(_)) => Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Speech request could not be read within its byte limit",
        )),
        Err(_) => Err(error(
            StatusCode::REQUEST_TIMEOUT,
            "Speech request timed out",
        )),
    }
}

async fn stt(req: Request<Incoming>, state: &State) -> Reply {
    if !state.whisper.ready() {
        return unavailable();
    }
    let started = Instant::now();
    let content_type = req.headers().get(CONTENT_TYPE).cloned();
    let bytes = match payload(req, LIMIT).await {
        Ok(bytes) => bytes,
        Err(reply) => return reply,
    };
    let mime = content_type
        .as_ref()
        .and_then(|header| header.to_str().ok())
        .unwrap_or("application/octet-stream");
    let Some((audio, format)) = upload::audio(bytes, mime) else {
        return error(
            StatusCode::BAD_REQUEST,
            "Expected a supported audio recording",
        );
    };
    match state
        .whisper
        .transcribe(&audio, format, Duration::from_secs(48))
        .await
    {
        Ok(reply) => json_reply(
            StatusCode::OK,
            json!({
                "transcript": reply.text, "duration_ms": reply.duration_ms, "stt_ms": started.elapsed().as_millis()
            }),
        ),
        Err(_) => error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Speech could not be transcribed",
        ),
    }
}

#[derive(Deserialize)]
struct Text {
    text: String,
    voice: Option<String>,
}

async fn tts(req: Request<Incoming>, state: &State) -> Reply {
    let started = Instant::now();
    let raw = req
        .uri()
        .query()
        .is_some_and(|query| query.split('&').any(|part| part == "raw=1"));
    let bytes = match payload(req, 24 * 1024).await {
        Ok(bytes) => bytes,
        Err(reply) => return reply,
    };
    let Ok(Text { text, voice }) = serde_json::from_slice(&bytes) else {
        return error(
            StatusCode::BAD_REQUEST,
            "Expected speech text and an optional voice",
        );
    };
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() || text.chars().take(4001).count() > 4000 {
        return error(StatusCode::BAD_REQUEST, "Speech text is empty or too long");
    }
    if !state.piper.installed(voice.as_deref()) {
        return error(
            StatusCode::NOT_FOUND,
            "The requested Piper voice is not installed",
        );
    }
    match state.piper.synthesize(&text, voice.as_deref()).await {
        Ok(wav) if raw => response(StatusCode::OK, "audio/wav", wav),
        Ok(wav) => state.retain(Bytes::from(wav), started),
        Err(_) => unavailable(),
    }
}

fn response(status: StatusCode, content_type: &'static str, body: impl Into<Bytes>) -> Reply {
    let mut response = Response::new(Full::new(body.into()));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        hyper::header::HeaderValue::from_static(content_type),
    );
    headers.insert(
        CACHE_CONTROL,
        hyper::header::HeaderValue::from_static("no-store"),
    );
    response
}

fn json_reply(status: StatusCode, value: Value) -> Reply {
    response(status, "application/json", value.to_string())
}

fn error(status: StatusCode, message: &'static str) -> Reply {
    json_reply(status, json!({"error": message}))
}

fn unavailable() -> Reply {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "Speech engine is unavailable",
    )
}
