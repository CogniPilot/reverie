use super::{Link, delivery::Source};
use crate::hands_chat::{Client, Error, Operation};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io;

pub(super) struct Office(Option<Client>);

pub(super) struct History {
    pub(super) rows: Vec<Value>,
    pub(super) zone: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct Failure {
    pub(super) name: String,
    pub(super) detail: String,
}

type Outcome<T> = io::Result<Result<T, Failure>>;

#[derive(Deserialize)]
#[serde(untagged)]
enum Answer {
    Success { value: Value },
    Error { error: Failure },
}

impl Office {
    pub(super) fn new(client: Option<Client>) -> Self {
        Self(client)
    }

    pub(super) fn rooms(&self, link: &mut Link) -> Outcome<Vec<Value>> {
        Ok(self.call(link, Operation::Rooms)?.and_then(rows))
    }

    pub(super) fn history(&self, link: &mut Link, room: &str, count: usize) -> Outcome<History> {
        let reply = self.call(
            link,
            Operation::History {
                room: room.to_owned(),
                count: count.to_string(),
            },
        )?;
        Ok(reply.and_then(|mut reply| {
            Ok(History {
                rows: rows(reply["messages"].take())?,
                zone: reply["timeZone"].as_str().map(str::to_owned),
            })
        }))
    }

    pub(super) fn allowed(&self, link: &mut Link, source: &Source<'_>) -> io::Result<bool> {
        let room = source.target.id;
        if self.0.is_none() {
            return link.exchange(json!({"effect":"alert","room":room,"message":source.message}));
        }
        match self.call(
            link,
            Operation::Exact {
                room: room.to_owned(),
                id: source.id.to_owned(),
            },
        )? {
            Ok(message) => Ok(message["phoneWake"] == true),
            Err(error) => {
                link.log(json!([
                    "phone acceptance unavailable; no reply",
                    room,
                    error.name
                ]))?;
                Ok(false)
            }
        }
    }

    pub(super) fn say(&self, link: &mut Link, source: &Source<'_>, text: &str) -> Outcome<Value> {
        self.call(
            link,
            Operation::Say {
                room: source.target.id.to_owned(),
                text: text.to_owned(),
                reply_to: Some(source.id.to_owned()),
            },
        )
    }

    fn call(&self, link: &mut Link, operation: Operation) -> Outcome<Value> {
        if let Some(client) = &self.0 {
            return Ok(client.call(&operation).map_err(Failure::native));
        }
        Ok(
            match link.exchange(json!({"effect":"chat","operation":operation}))? {
                Answer::Success { value } => Ok(value),
                Answer::Error { error } => Err(error),
            },
        )
    }
}

impl Failure {
    fn native(error: Error) -> Self {
        let (name, detail) = match error {
            Error::NotFound => ("ChatNotFound", "no such message in this room"),
            Error::Timeout => ("TimeoutExpired", "Office chat deadline"),
            Error::Invalid(reason) => ("ValueError", reason),
            Error::Unavailable => ("RuntimeError", "Office chat unavailable"),
        };
        Self {
            name: name.to_owned(),
            detail: detail.to_owned(),
        }
    }
}

fn rows(value: Value) -> Result<Vec<Value>, Failure> {
    Vec::deserialize(value).map_err(|_| Failure::native(Error::Invalid("invalid Office rows")))
}
