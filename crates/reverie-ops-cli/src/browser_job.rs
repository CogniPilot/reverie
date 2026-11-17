//! Fixed browser-job commands carry only a request-message reference.
use crate::{
    Result, Unavailable,
    address::OfficePhone,
    transport::{self, Endpoint, OfficeReply},
};
use clap::ValueEnum;
use reverie_core::ids::ChatMessageId;
use serde_json::{Value, json};
use std::ffi::OsStr;

const UNAVAILABLE: &str = "BROWSER_JOB_UNAVAILABLE";

#[derive(Clone, Copy, ValueEnum)]
pub(crate) enum Action {
    Submit,
    Inspect,
    Cancel,
}

impl Action {
    fn as_str(self) -> &'static str {
        match self {
            Self::Submit => "submit",
            Self::Inspect => "inspect",
            Self::Cancel => "cancel",
        }
    }
}

pub(crate) fn run(action: Action, message: &OsStr) -> (Vec<u8>, u8) {
    let response = request(action, message);
    let (bytes, code) = match response {
        Ok(Reply::Data(data)) => (format!(r#"{{"success":true,"data":{data}}}"#), 0),
        Ok(Reply::Refused(error)) => (refusal(error), 3),
        Err(_) => (refusal(UNAVAILABLE), 3),
    };
    (bytes.into_bytes(), code)
}

fn refusal(code: &'static str) -> String {
    format!(r#"{{"success":false,"errorCode":"{code}"}}"#)
}

enum Reply {
    Data(Value),
    Refused(&'static str),
}

fn request(action: Action, message: &OsStr) -> Result<Reply> {
    let message = message.to_str().ok_or(Unavailable)?;
    // The installed command has always accepted both cases. Preserve the
    // supplied spelling in the body and require the same spelling in reply.
    ChatMessageId::parse(&message.to_ascii_lowercase()).map_err(|_| Unavailable)?;
    let url = std::env::var("REVERIE_API_URL").map_err(|_| Unavailable)?;
    let phone = OfficePhone::for_browser_job(&url)?;
    let body = json!({"action": action.as_str(), "requestMessageId": message});
    let body = serde_json::to_vec(&body).map_err(|_| Unavailable)?;
    decode(
        transport::post(phone, Endpoint::BrowserJob, &body)?,
        message,
    )
}

fn decode(reply: OfficeReply, message: &str) -> Result<Reply> {
    if !matches!(reply.status.as_u16(), 200 | 403 | 502 | 503) {
        return Err(Unavailable);
    }
    let mut value = serde_json::from_slice::<Value>(&reply.body).map_err(|_| Unavailable)?;
    let fields = value.as_object_mut().ok_or(Unavailable)?;
    if fields.get("success") != Some(&Value::Bool(true)) {
        let code = match fields.get("errorCode").and_then(Value::as_str) {
            Some("BROWSER_JOB_REFUSED") => "BROWSER_JOB_REFUSED",
            Some("BROWSER_JOB_UNCONFIRMED_INSPECT_BEFORE_RETRY") => {
                "BROWSER_JOB_UNCONFIRMED_INSPECT_BEFORE_RETRY"
            }
            _ => UNAVAILABLE,
        };
        return Ok(Reply::Refused(code));
    }
    let data = fields.remove("data").ok_or(Unavailable)?;
    let fields = data.as_object().ok_or(Unavailable)?;
    if fields.get("requestMessageId").and_then(Value::as_str) != Some(message)
        || !fields.keys().all(|key| {
            matches!(
                key.as_str(),
                "jobId" | "state" | "requestMessageId" | "artifacts"
            )
        })
    {
        return Err(Unavailable);
    }
    Ok(Reply::Data(data))
}
