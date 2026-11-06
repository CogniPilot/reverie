//! The handler side of `route_frames_v1`: one generation's requests, served one at a time.
//!
//! The handler is Idle, serving a request, or Awaiting the observation it asked for. In Idle the
//! only valid frames are the next request (`id == last + 1`) and a late cancel of the request it
//! already answered. While Awaiting, only that request's observation or cancel is valid. Every
//! request gets exactly one response or refusal, so TS always knows which frame comes next.
use crate::settings;
use crate::subscription_profiles::{self, Pending, Read as ProfilesRead};
use reverie_contracts::route_frames_v1::{
    self as frames, Body, Direction, Frame, FrameError, Media, Observation,
};
use reverie_contracts::settings_v1::ContentType;
use reverie_contracts::subscription_profiles_v1::{self as profiles, Refusal, Response};
use std::fmt;
use std::io::{self, Read, Write};

/// Refusal codes the channel itself sends; route refusals use their own codes.
pub const UNKNOWN_ROUTE: &str = "UNKNOWN_ROUTE";
pub const CANCELED: &str = "CANCELED";

/// Why the handler stopped before the end of its input. Every one ends the generation.
#[derive(Debug, Eq, PartialEq)]
pub enum Fatal {
    Frame(FrameError),
    /// A frame valid on its own but not in the handler's current state.
    Sequence,
    Generation,
    /// End of input while an observation was awaited.
    Abandoned,
    Write,
}

impl fmt::Display for Fatal {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Frame(error) => output.write_str(error.code()),
            Self::Sequence => output.write_str("FRAME_SEQUENCE"),
            Self::Generation => output.write_str("FRAME_GENERATION"),
            Self::Abandoned => output.write_str("FRAME_ABANDONED"),
            Self::Write => output.write_str("FRAME_WRITE"),
        }
    }
}

struct Channel<'a, I, O> {
    generation: u64,
    input: &'a mut I,
    output: &'a mut O,
}

/// Serves `generation` until end of input in Idle (`Ok`) or the first fatal frame.
pub fn serve(generation: u64, input: &mut impl Read, output: &mut impl Write) -> Result<(), Fatal> {
    let mut channel = Channel {
        generation,
        input,
        output,
    };
    let mut last = 0;
    while let Some(frame) = channel.next()? {
        match frame.body {
            Body::Request { route, json } if frame.id == last + 1 => {
                last = frame.id;
                channel.request(frame.id, &route, &json)?;
            }
            Body::Cancel if last != 0 && frame.id == last => {}
            _ => return Err(Fatal::Sequence),
        }
    }
    Ok(())
}

impl<I: Read, O: Write> Channel<'_, I, O> {
    fn next(&mut self) -> Result<Option<Frame>, Fatal> {
        let frame = frames::read_frame(self.input, Direction::ToHandler).map_err(Fatal::Frame)?;
        match frame {
            Some(frame) if frame.generation != self.generation => Err(Fatal::Generation),
            frame => Ok(frame),
        }
    }

    fn send(&mut self, id: u64, body: Body) -> Result<(), Fatal> {
        let frame = Frame {
            generation: self.generation,
            id,
            body,
        };
        let wire = frame.encode().map_err(Fatal::Frame)?;
        self.output
            .write_all(&wire)
            .and_then(|()| self.output.flush())
            .map_err(|_: io::Error| Fatal::Write)
    }

    fn refuse(&mut self, id: u64, code: &str) -> Result<(), Fatal> {
        self.send(
            id,
            Body::Refusal {
                code: code.to_string(),
            },
        )
    }

    fn answer(&mut self, id: u64, outcome: Result<Response, Refusal>) -> Result<(), Fatal> {
        match outcome {
            Ok(response) => self.send(
                id,
                Body::Response {
                    status: response.status,
                    body: response.body,
                },
            ),
            Err(refusal) => self.refuse(id, refusal.code()),
        }
    }

    fn request(&mut self, id: u64, route: &str, json: &[u8]) -> Result<(), Fatal> {
        match route {
            frames::SUBSCRIPTION_PROFILES => self.subscription_profiles(id, json),
            frames::SETTINGS => self.settings(id, json),
            _ => self.refuse(id, UNKNOWN_ROUTE),
        }
    }

    /// Settings answers in one step, always with a typed response.
    fn settings(&mut self, id: u64, json: &[u8]) -> Result<(), Fatal> {
        match settings::answer(json) {
            Ok(response) => self.send(
                id,
                Body::TypedResponse {
                    media: match response.content_type {
                        ContentType::Json => Media::ApplicationJsonUtf8,
                        ContentType::PlainText => Media::TextPlainUtf8,
                    },
                    status: response.status,
                    body: response.body,
                },
            ),
            Err(refusal) => self.refuse(id, refusal.code()),
        }
    }

    fn subscription_profiles(&mut self, id: u64, json: &[u8]) -> Result<(), Fatal> {
        let read = profiles::decode_request(json)
            .and_then(|request| subscription_profiles::read(&request));
        match read {
            Ok(ProfilesRead::Done(response)) => self.answer(id, Ok(response)),
            Ok(ProfilesRead::NeedModes(pending)) => self.observe_modes(id, pending),
            Err(refusal) => self.answer(id, Err(refusal)),
        }
    }

    /// Asks TS for the modes and waits for exactly that answer or its cancel.
    fn observe_modes(&mut self, id: u64, pending: Pending) -> Result<(), Fatal> {
        let providers = pending.providers();
        self.send(
            id,
            Body::Observe {
                observation: Observation::SubscriptionModes,
                providers: providers.clone(),
            },
        )?;
        let frame = self.next()?.ok_or(Fatal::Abandoned)?;
        if frame.id != id {
            return Err(Fatal::Sequence);
        }
        match frame.body {
            Body::Observed {
                observation: Observation::SubscriptionModes,
                json,
            } => {
                let outcome = profiles::decode_modes(&json, &providers)
                    .and_then(|modes| subscription_profiles::finish(pending, &modes));
                self.answer(id, outcome)
            }
            Body::Cancel => self.refuse(id, CANCELED),
            _ => Err(Fatal::Sequence),
        }
    }
}
