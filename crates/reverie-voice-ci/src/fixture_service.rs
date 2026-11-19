//! Loopback HTTP fixture connecting the actual speech engines to the console tests.
mod synthesis;
mod whisper;

use crate::{FIXTURE, Result};
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
use reverie_kokoro::Engine;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    convert::Infallible,
    fs::{self, OpenOptions},
    io::{self, Write},
    net::Ipv4Addr,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use synthesis::{Outcome, Speech};
use tokio::{
    net::{TcpListener, TcpStream},
    signal::unix::{SignalKind, signal},
    sync::{OwnedSemaphorePermit, Semaphore},
    time,
};
use whisper::Whisper;

const BODY_LIMIT: usize = 10 * 1024 * 1024;
const READ_LIMIT: Duration = Duration::from_secs(30);
const MAX_CONNECTIONS: usize = 16;
const MAX_AUDIO: usize = 16;

type Reply = Response<Full<Bytes>>;

struct State {
    speech: Speech,
    whisper: Whisper,
    audio: Mutex<HashMap<String, Bytes>>,
}

pub(super) fn nonce() -> Result<String> {
    let mut value = [0_u8; 16];
    getrandom::getrandom(&mut value).map_err(|error| io::Error::other(error.to_string()))?;
    Ok(value.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn selected(key: &str) -> Result<PathBuf> {
    std::env::var_os(key)
        .map(PathBuf::from)
        .ok_or_else(|| format!("Missing {key}").into())
}

pub(super) async fn serve(artifacts: &Path) -> Result<()> {
    let root = fs::canonicalize(artifacts)?;
    let model = selected("REVERIE_VOICE_CI_KOKORO_MODEL")?;
    let voices = selected("REVERIE_VOICE_CI_KOKORO_VOICES")?;
    let whisper = Whisper::open(selected("REVERIE_VOICE_CI_WHISPER_MODEL")?, &root)?;
    let fixture: Value = serde_json::from_str(FIXTURE)?;
    let default = fixture["voice"]
        .as_str()
        .ok_or("Missing fixture voice")?
        .to_owned();
    let engine = Engine::load_files(&model, &voices)?;
    let speech = Speech::new(engine, &root, default)?;
    let state = Arc::new(State {
        speech,
        whisper,
        audio: Mutex::new(HashMap::new()),
    });
    let socket = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let url = format!("http://{}", socket.local_addr()?);
    let mut ready = OpenOptions::new()
        .mode(0o600)
        .write(true)
        .create_new(true)
        .open(root.join("speech-url.txt"))?;
    ready.write_all(url.as_bytes())?;
    let mut terminate = signal(SignalKind::terminate())?;
    tokio::select! {
        served = listen(socket, state) => served,
        _ = terminate.recv() => Ok(()),
        interrupted = tokio::signal::ctrl_c() => Ok(interrupted?),
    }
}

async fn listen(socket: TcpListener, state: Arc<State>) -> Result<()> {
    let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        let (stream, _) = socket.accept().await?;
        if let Ok(permit) = Arc::clone(&permits).try_acquire_owned() {
            tokio::spawn(connection(stream, Arc::clone(&state), permit));
        }
    }
}

async fn connection(stream: TcpStream, state: Arc<State>, _permit: OwnedSemaphorePermit) {
    let result = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(READ_LIMIT)
        .keep_alive(false)
        .serve_connection(
            TokioIo::new(stream),
            service_fn(move |request| dispatch(request, Arc::clone(&state))),
        )
        .await;
    if let Err(error) = result {
        eprintln!("voice-ci HTTP connection ended: {error}");
    }
}

async fn dispatch(
    request: Request<Incoming>,
    state: Arc<State>,
) -> std::result::Result<Reply, Infallible> {
    let result = match (request.method(), request.uri().path()) {
        (&Method::GET, "/health") => Ok(json_reply(
            StatusCode::OK,
            json!({"status":"ok","stt":"ready","tts":"ready"}),
        )),
        (&Method::GET, "/voices") => Ok(json_reply(
            StatusCode::OK,
            json!({"voices":state.speech.voices()}),
        )),
        (&Method::GET, path) if path.starts_with("/audio/") => {
            state.audio(path.trim_start_matches("/audio/"))
        }
        (&Method::POST, "/stt" | "/tts") => post(request, &state).await,
        _ => Ok(error(StatusCode::NOT_FOUND, "No fixture resource")),
    };
    Ok(result.unwrap_or_else(|failure| {
        eprintln!("voice-ci speech request failed: {failure}");
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Speech fixture request failed",
        )
    }))
}

async fn post(request: Request<Incoming>, state: &State) -> Result<Reply> {
    let started = synthesis::now()?;
    let stt = request.uri().path() == "/stt";
    let length = request
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    if !length.is_some_and(|length| (1..=BODY_LIMIT).contains(&length)) {
        return Ok(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Fixture request too large or empty",
        ));
    }
    let body = time::timeout(
        READ_LIMIT,
        Limited::new(request.into_body(), BODY_LIMIT).collect(),
    )
    .await??
    .to_bytes();
    if stt {
        let transcript = state.whisper.transcribe(&body).await?;
        return Ok(json_reply(StatusCode::OK, json!({"transcript":transcript})));
    }
    match state.speech.synthesize(&body, started).await? {
        Outcome::Ready { audio, raw: true } => Ok(wav(audio)),
        Outcome::Ready { audio, raw: false } => state.retain(audio),
        Outcome::Busy => Ok(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Kokoro is busy; try again",
        )),
    }
}

impl State {
    fn retain(&self, bytes: Bytes) -> Result<Reply> {
        let mut audio = self.audio.lock().map_err(|_| "Audio cache lock poisoned")?;
        if audio.len() == MAX_AUDIO {
            return Ok(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Fixture audio capacity reached",
            ));
        }
        let id = nonce()?;
        audio.insert(id.clone(), bytes);
        Ok(json_reply(
            StatusCode::OK,
            json!({"audio_url":format!("/audio/{id}")}),
        ))
    }

    fn audio(&self, id: &str) -> Result<Reply> {
        let audio = self.audio.lock().map_err(|_| "Audio cache lock poisoned")?;
        Ok(audio
            .get(id)
            .cloned()
            .map_or_else(|| error(StatusCode::NOT_FOUND, "No fixture resource"), wav))
    }
}

fn response(status: StatusCode, content_type: &'static str, body: impl Into<Bytes>) -> Reply {
    let mut reply = Response::new(Full::new(body.into()));
    *reply.status_mut() = status;
    reply.headers_mut().insert(
        CONTENT_TYPE,
        hyper::header::HeaderValue::from_static(content_type),
    );
    reply
}

fn wav(bytes: Bytes) -> Reply {
    response(StatusCode::OK, "audio/wav", bytes)
}

fn json_reply(status: StatusCode, value: Value) -> Reply {
    response(status, "application/json", value.to_string())
}

fn error(status: StatusCode, message: &'static str) -> Reply {
    json_reply(status, json!({"error":message}))
}
