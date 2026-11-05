//! `route_frames_v1`: the frames between the TS front and a Rust route handler child on its
//! stdin and stdout. Every frame is a big-endian `u32 length`, then `u8 version | u8 kind |
//! u64 generation | u64 id` (18 bytes, no padding), then the kind's payload; `length` counts
//! everything after itself. A reader checks `length` against its direction after 4 bytes and
//! against the kind after 6, so no payload buffer is allocated for a frame it would refuse.
use crate::subscription_profiles_v1::{self as profiles, Provider};
use std::fmt;
use std::io::{self, Read};

pub const VERSION: u8 = 1;
/// Bytes after the length field and before the payload.
pub const HEADER_BYTES: usize = 18;
pub const MAX_ROUTE_KEY_BYTES: usize = 64;
pub const MAX_REQUEST_JSON_BYTES: usize = profiles::MAX_REQUEST_BYTES;
pub const MAX_OBSERVED_JSON_BYTES: usize = 64 << 10;
pub const MAX_REFUSAL_CODE_BYTES: usize = 64;

/// A route the handler serves, with the statuses its responses may carry. The content type is
/// fixed per route, so a response frame carries no headers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Route {
    pub key: &'static str,
    pub statuses: &'static [u16],
    pub content_type: &'static str,
}

pub const ROUTES: &[Route] = &[Route {
    key: "GET /api/subscription-profiles",
    statuses: &[200, 500],
    content_type: profiles::CONTENT_TYPE,
}];

pub fn route(key: &str) -> Option<&'static Route> {
    ROUTES.iter().find(|route| route.key == key)
}

/// Which side reads the frame.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Direction {
    /// TS writes, the handler reads.
    ToHandler,
    /// The handler writes, TS reads.
    ToFront,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Kind {
    Request,
    Response,
    Refusal,
    Cancel,
    Observe,
    Observed,
}

const KINDS: [Kind; 6] = [
    Kind::Request,
    Kind::Response,
    Kind::Refusal,
    Kind::Cancel,
    Kind::Observe,
    Kind::Observed,
];

impl Kind {
    pub fn byte(self) -> u8 {
        match self {
            Self::Request => 1,
            Self::Response => 2,
            Self::Refusal => 3,
            Self::Cancel => 4,
            Self::Observe => 5,
            Self::Observed => 6,
        }
    }
    fn from_byte(byte: u8) -> Option<Self> {
        KINDS.into_iter().find(|kind| kind.byte() == byte)
    }
    pub fn direction(self) -> Direction {
        match self {
            Self::Request | Self::Cancel | Self::Observed => Direction::ToHandler,
            Self::Response | Self::Refusal | Self::Observe => Direction::ToFront,
        }
    }
    /// The inclusive `length` range of this kind.
    pub fn lengths(self) -> (usize, usize) {
        let payload = match self {
            Self::Request => (2, 1 + MAX_ROUTE_KEY_BYTES + MAX_REQUEST_JSON_BYTES),
            Self::Response => (2, 2 + profiles::MAX_RESPONSE_BYTES),
            Self::Refusal => (1, MAX_REFUSAL_CODE_BYTES),
            Self::Cancel => (0, 0),
            Self::Observe => (3, 4),
            Self::Observed => (2, 1 + MAX_OBSERVED_JSON_BYTES),
        };
        (HEADER_BYTES + payload.0, HEADER_BYTES + payload.1)
    }
}

impl Direction {
    /// The largest `length` any frame read in this direction may declare.
    pub fn max_length(self) -> usize {
        KINDS
            .into_iter()
            .filter(|kind| kind.direction() == self)
            .map(|kind| kind.lengths().1)
            .max()
            .unwrap_or(HEADER_BYTES)
    }
}

/// A TS-owned observation the handler asks for between its read and finish phases.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Observation {
    SubscriptionModes,
}
impl Observation {
    fn byte(self) -> u8 {
        match self {
            Self::SubscriptionModes => 1,
        }
    }
    fn from_byte(byte: u8) -> Option<Self> {
        (byte == 1).then_some(Self::SubscriptionModes)
    }
}

fn provider_byte(provider: Provider) -> u8 {
    match provider {
        Provider::Anthropic => 1,
        Provider::Openai => 2,
    }
}
fn provider_from_byte(byte: u8) -> Option<Provider> {
    [Provider::Anthropic, Provider::Openai]
        .into_iter()
        .find(|provider| provider_byte(*provider) == byte)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Body {
    Request {
        route: String,
        json: Vec<u8>,
    },
    Response {
        status: u16,
        body: Vec<u8>,
    },
    Refusal {
        code: String,
    },
    Cancel,
    /// Distinct providers in first-appearance order.
    Observe {
        observation: Observation,
        providers: Vec<Provider>,
    },
    Observed {
        observation: Observation,
        json: Vec<u8>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Frame {
    pub generation: u64,
    pub id: u64,
    pub body: Body,
}

/// Why a frame was refused. Every one ends the channel generation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FrameError {
    Truncated,
    Length,
    Version,
    Kind,
    Identity,
    Payload,
    Io,
}
impl FrameError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Truncated => "FRAME_TRUNCATED",
            Self::Length => "FRAME_LENGTH",
            Self::Version => "FRAME_VERSION",
            Self::Kind => "FRAME_KIND",
            Self::Identity => "FRAME_IDENTITY",
            Self::Payload => "FRAME_PAYLOAD",
            Self::Io => "FRAME_IO",
        }
    }
}
impl fmt::Display for FrameError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for FrameError {}

impl Body {
    fn kind(&self) -> Kind {
        match self {
            Self::Request { .. } => Kind::Request,
            Self::Response { .. } => Kind::Response,
            Self::Refusal { .. } => Kind::Refusal,
            Self::Cancel => Kind::Cancel,
            Self::Observe { .. } => Kind::Observe,
            Self::Observed { .. } => Kind::Observed,
        }
    }
    fn payload(&self) -> Vec<u8> {
        match self {
            Self::Request { route, json } => {
                let mut payload = vec![route.len() as u8];
                payload.extend_from_slice(route.as_bytes());
                payload.extend_from_slice(json);
                payload
            }
            Self::Response { status, body } => [&status.to_be_bytes()[..], body].concat(),
            Self::Refusal { code } => code.as_bytes().to_vec(),
            Self::Cancel => Vec::new(),
            Self::Observe {
                observation,
                providers,
            } => [observation.byte(), providers.len() as u8]
                .into_iter()
                .chain(providers.iter().map(|provider| provider_byte(*provider)))
                .collect(),
            Self::Observed { observation, json } => [&[observation.byte()][..], json].concat(),
        }
    }
}

impl Frame {
    /// The wire bytes, or the error a reader would refuse them with.
    pub fn encode(&self) -> Result<Vec<u8>, FrameError> {
        let kind = self.body.kind();
        let payload = self.body.payload();
        let frame = [
            &[VERSION, kind.byte()][..],
            &self.generation.to_be_bytes(),
            &self.id.to_be_bytes(),
            &payload,
        ]
        .concat();
        let length = u32::try_from(frame.len()).map_err(|_| FrameError::Length)?;
        let wire = [&length.to_be_bytes()[..], &frame].concat();
        let decoded = read_frame(&mut wire.as_slice(), kind.direction())?;
        if decoded.as_ref() != Some(self) {
            return Err(FrameError::Payload);
        }
        Ok(wire)
    }
}

/// Fills `buffer`; `Ok(false)` only for end of input before its first byte.
fn fill(reader: &mut impl Read, buffer: &mut [u8], at_boundary: bool) -> Result<bool, FrameError> {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..]) {
            Ok(0) if filled == 0 && at_boundary => return Ok(false),
            Ok(0) => return Err(FrameError::Truncated),
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err(FrameError::Io),
        }
    }
    Ok(true)
}

/// Reads one frame sent in `direction`; `Ok(None)` is end of input between frames.
pub fn read_frame(
    reader: &mut impl Read,
    direction: Direction,
) -> Result<Option<Frame>, FrameError> {
    let mut length = [0; 4];
    if !fill(reader, &mut length, true)? {
        return Ok(None);
    }
    let length = u32::from_be_bytes(length) as usize;
    if !(HEADER_BYTES..=direction.max_length()).contains(&length) {
        return Err(FrameError::Length);
    }
    let mut lead = [0; 2];
    fill(reader, &mut lead, false)?;
    if lead[0] != VERSION {
        return Err(FrameError::Version);
    }
    let kind = Kind::from_byte(lead[1])
        .filter(|kind| kind.direction() == direction)
        .ok_or(FrameError::Kind)?;
    let (min, max) = kind.lengths();
    if !(min..=max).contains(&length) {
        return Err(FrameError::Length);
    }
    let mut rest = vec![0; length - 2];
    fill(reader, &mut rest, false)?;
    let generation = u64::from_be_bytes(rest[0..8].try_into().expect("8 bytes"));
    let id = u64::from_be_bytes(rest[8..16].try_into().expect("8 bytes"));
    if generation == 0 || id == 0 {
        return Err(FrameError::Identity);
    }
    let body = body(kind, &rest[16..]).ok_or(FrameError::Payload)?;
    Ok(Some(Frame {
        generation,
        id,
        body,
    }))
}

fn body(kind: Kind, payload: &[u8]) -> Option<Body> {
    Some(match kind {
        Kind::Request => {
            let (&route_len, rest) = payload.split_first()?;
            let route_len = usize::from(route_len);
            if route_len == 0 || route_len > MAX_ROUTE_KEY_BYTES || rest.len() < route_len {
                return None;
            }
            let (route, json) = rest.split_at(route_len);
            // The route's own request decoder bounds the JSON.
            let route = std::str::from_utf8(route)
                .ok()
                .filter(|route| route.is_ascii())?;
            Body::Request {
                route: route.to_string(),
                json: json.to_vec(),
            }
        }
        Kind::Response => {
            let (status, body) = payload.split_at_checked(2)?;
            // The front checks the status against the route it dispatched.
            let status = u16::from_be_bytes(status.try_into().ok()?);
            Body::Response {
                status,
                body: body.to_vec(),
            }
        }
        Kind::Refusal => {
            let code = std::str::from_utf8(payload).ok()?;
            if !code
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
            {
                return None;
            }
            Body::Refusal {
                code: code.to_string(),
            }
        }
        Kind::Cancel => Body::Cancel,
        Kind::Observe => {
            let [observation, count, providers @ ..] = payload else {
                return None;
            };
            let observation = Observation::from_byte(*observation)?;
            if !(1..=2).contains(count) || providers.len() != usize::from(*count) {
                return None;
            }
            let providers = providers
                .iter()
                .map(|byte| provider_from_byte(*byte))
                .collect::<Option<Vec<_>>>()?;
            if providers.len() == 2 && providers[0] == providers[1] {
                return None;
            }
            Body::Observe {
                observation,
                providers,
            }
        }
        Kind::Observed => {
            let (&observation, json) = payload.split_first()?;
            Body::Observed {
                observation: Observation::from_byte(observation)?,
                json: json.to_vec(),
            }
        }
    })
}

#[cfg(test)]
mod tests;
