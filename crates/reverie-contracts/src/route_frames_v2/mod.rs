//! `route_frames_v2`: the frames between the Rust front and its TS child on one inherited socket
//! (fd 3 in the child). The front owns every public socket; each accepted connection is relayed
//! as a byte stream in `data` frames, and lifecycle frames bind and close the listeners.
//!
//! Framing is v1's: a big-endian `u32 length`, then `u8 version | u8 kind | u64 generation |
//! u64 id` (18 bytes), then the kind's payload; `length` counts everything after itself. A reader
//! checks `length` against its direction after 4 bytes and against the kind after 6, so no payload
//! buffer is allocated for a frame it would refuse. Lifecycle frames carry id 0; connection frames
//! carry the connection id, which is never 0. Per-connection ordering rules are in [`conn`].
use std::fmt;
use std::io::{self, Read};

pub mod conn;

pub const VERSION: u8 = 2;
/// Bytes after the length field and before the payload.
pub const HEADER_BYTES: usize = 18;
pub const MAX_DATA_BYTES: usize = 64 << 10;
pub const MAX_HOST_BYTES: usize = 255;
pub const MAX_ERRNO_BYTES: usize = 32;
pub const MAX_MESSAGE_BYTES: usize = 512;
/// `listener`, `family`, two 16-byte addresses with their ports, and `encrypted`.
const CONN_OPEN_BYTES: usize = 1 + 1 + (16 + 2) * 2 + 1;

/// Which side reads the frame.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Direction {
    /// TS writes, the front reads.
    ToFront,
    /// The front writes, TS reads.
    ToTs,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Kind {
    BindRequest,
    Bound,
    BindFailed,
    Accepting,
    ServiceReady,
    Unbind,
    Shutdown,
    ConnOpen,
    Data,
    End,
    Abort,
    Credit,
}

const KINDS: [Kind; 12] = [
    Kind::BindRequest,
    Kind::Bound,
    Kind::BindFailed,
    Kind::Accepting,
    Kind::ServiceReady,
    Kind::Unbind,
    Kind::Shutdown,
    Kind::ConnOpen,
    Kind::Data,
    Kind::End,
    Kind::Abort,
    Kind::Credit,
];

impl Kind {
    pub fn byte(self) -> u8 {
        match self {
            Self::BindRequest => 1,
            Self::Bound => 2,
            Self::BindFailed => 3,
            Self::Accepting => 4,
            Self::ServiceReady => 5,
            Self::Unbind => 6,
            Self::Shutdown => 7,
            Self::ConnOpen => 16,
            Self::Data => 17,
            Self::End => 18,
            Self::Abort => 19,
            Self::Credit => 20,
        }
    }
    fn from_byte(byte: u8) -> Option<Self> {
        KINDS.into_iter().find(|kind| kind.byte() == byte)
    }
    /// Whether this kind may be read in `direction`. Stream kinds travel both ways.
    pub fn allows(self, direction: Direction) -> bool {
        match self {
            Self::BindRequest | Self::Accepting | Self::ServiceReady | Self::Unbind => {
                direction == Direction::ToFront
            }
            Self::Bound | Self::BindFailed | Self::Shutdown | Self::ConnOpen => {
                direction == Direction::ToTs
            }
            Self::Data | Self::End | Self::Abort | Self::Credit => true,
        }
    }
    /// Lifecycle kinds carry id 0; connection kinds carry a connection id.
    pub fn is_connection(self) -> bool {
        matches!(
            self,
            Self::ConnOpen | Self::Data | Self::End | Self::Abort | Self::Credit
        )
    }
    /// The inclusive `length` range of this kind.
    pub fn lengths(self) -> (usize, usize) {
        let payload = match self {
            Self::BindRequest => (6, 5 + MAX_HOST_BYTES),
            Self::Bound => (3, 3),
            Self::BindFailed => (3, 2 + MAX_ERRNO_BYTES + MAX_MESSAGE_BYTES),
            Self::Accepting | Self::Unbind | Self::Shutdown | Self::Abort => (1, 1),
            Self::ServiceReady | Self::End => (0, 0),
            Self::ConnOpen => (CONN_OPEN_BYTES, CONN_OPEN_BYTES),
            Self::Data => (1, MAX_DATA_BYTES),
            Self::Credit => (4, 4),
        };
        (HEADER_BYTES + payload.0, HEADER_BYTES + payload.1)
    }
}

impl Direction {
    /// The largest `length` any frame read in this direction may declare.
    pub fn max_length(self) -> usize {
        KINDS
            .into_iter()
            .filter(|kind| kind.allows(self))
            .map(|kind| kind.lengths().1)
            .max()
            .unwrap_or(HEADER_BYTES)
    }
}

/// One finite byte per variant, in declaration order from `first`.
macro_rules! byte_enum {
    ($name:ident, $first:literal, [$($variant:ident),+ $(,)?]) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub enum $name {
            $($variant),+
        }
        impl $name {
            const ALL: &'static [Self] = &[$(Self::$variant),+];
            pub fn byte(self) -> u8 {
                $first + Self::ALL.iter().position(|item| *item == self).expect("listed") as u8
            }
            fn from_byte(byte: u8) -> Option<Self> {
                Self::ALL.iter().copied().find(|item| item.byte() == byte)
            }
        }
    };
}

byte_enum!(Listener, 0, [Main, Bridge]);
byte_enum!(Signal, 1, [Term, Int, Hup]);
byte_enum!(AbortReason, 0, [PeerReset, Destroy, Timeout, Generation]);

/// A peer or local socket address as the front saw it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SocketFacts {
    pub address: std::net::IpAddr,
    pub port: u16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Body {
    BindRequest {
        listener: Listener,
        tls: bool,
        port: u16,
        host: String,
    },
    Bound {
        listener: Listener,
        port: u16,
    },
    BindFailed {
        listener: Listener,
        errno: String,
        message: String,
    },
    Accepting {
        listener: Listener,
    },
    ServiceReady,
    Unbind {
        listener: Listener,
    },
    Shutdown {
        signal: Signal,
    },
    /// Both addresses share one family: IPv4 is sent as its 4 bytes and 12 zero bytes.
    ConnOpen {
        listener: Listener,
        peer: SocketFacts,
        local: SocketFacts,
        encrypted: bool,
    },
    Data(Vec<u8>),
    End,
    Abort(AbortReason),
    Credit(u32),
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

fn facts_bytes(facts: &SocketFacts) -> [u8; 18] {
    let mut bytes = [0; 18];
    match facts.address {
        std::net::IpAddr::V4(v4) => bytes[..4].copy_from_slice(&v4.octets()),
        std::net::IpAddr::V6(v6) => bytes[..16].copy_from_slice(&v6.octets()),
    }
    bytes[16..].copy_from_slice(&facts.port.to_be_bytes());
    bytes
}

impl Body {
    pub fn kind(&self) -> Kind {
        match self {
            Self::BindRequest { .. } => Kind::BindRequest,
            Self::Bound { .. } => Kind::Bound,
            Self::BindFailed { .. } => Kind::BindFailed,
            Self::Accepting { .. } => Kind::Accepting,
            Self::ServiceReady => Kind::ServiceReady,
            Self::Unbind { .. } => Kind::Unbind,
            Self::Shutdown { .. } => Kind::Shutdown,
            Self::ConnOpen { .. } => Kind::ConnOpen,
            Self::Data(_) => Kind::Data,
            Self::End => Kind::End,
            Self::Abort(_) => Kind::Abort,
            Self::Credit(_) => Kind::Credit,
        }
    }
    fn payload(&self) -> Vec<u8> {
        match self {
            Self::BindRequest {
                listener,
                tls,
                port,
                host,
            } => [
                &[listener.byte(), u8::from(*tls)][..],
                &port.to_be_bytes(),
                &[host.len() as u8],
                host.as_bytes(),
            ]
            .concat(),
            Self::Bound { listener, port } => {
                [&[listener.byte()][..], &port.to_be_bytes()].concat()
            }
            Self::BindFailed {
                listener,
                errno,
                message,
            } => [
                &[listener.byte(), errno.len() as u8][..],
                errno.as_bytes(),
                message.as_bytes(),
            ]
            .concat(),
            Self::Accepting { listener } | Self::Unbind { listener } => vec![listener.byte()],
            Self::ServiceReady | Self::End => Vec::new(),
            Self::Shutdown { signal } => vec![signal.byte()],
            Self::ConnOpen {
                listener,
                peer,
                local,
                encrypted,
            } => {
                let family = if peer.address.is_ipv4() { 4 } else { 6 };
                [
                    &[listener.byte(), family][..],
                    &facts_bytes(peer),
                    &facts_bytes(local),
                    &[u8::from(*encrypted)],
                ]
                .concat()
            }
            Self::Data(bytes) => bytes.clone(),
            Self::Abort(reason) => vec![reason.byte()],
            Self::Credit(bytes) => bytes.to_be_bytes().to_vec(),
        }
    }
}

impl Frame {
    /// The wire bytes, or the error a reader in `direction` would refuse them with.
    pub fn encode(&self, direction: Direction) -> Result<Vec<u8>, FrameError> {
        let kind = self.body.kind();
        let frame = [
            &[VERSION, kind.byte()][..],
            &self.generation.to_be_bytes(),
            &self.id.to_be_bytes(),
            &self.body.payload(),
        ]
        .concat();
        let length = u32::try_from(frame.len()).map_err(|_| FrameError::Length)?;
        let wire = [&length.to_be_bytes()[..], &frame].concat();
        let decoded = read_frame(&mut wire.as_slice(), direction)?;
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
        .filter(|kind| kind.allows(direction))
        .ok_or(FrameError::Kind)?;
    let (min, max) = kind.lengths();
    if !(min..=max).contains(&length) {
        return Err(FrameError::Length);
    }
    let mut rest = vec![0; length - 2];
    fill(reader, &mut rest, false)?;
    let generation = u64::from_be_bytes(rest[0..8].try_into().expect("8 bytes"));
    let id = u64::from_be_bytes(rest[8..16].try_into().expect("8 bytes"));
    if generation == 0 || kind.is_connection() == (id == 0) {
        return Err(FrameError::Identity);
    }
    let body = body(kind, &rest[16..]).ok_or(FrameError::Payload)?;
    Ok(Some(Frame {
        generation,
        id,
        body,
    }))
}

fn utf8(bytes: &[u8]) -> Option<String> {
    std::str::from_utf8(bytes).ok().map(str::to_string)
}

fn errno(bytes: &[u8]) -> Option<String> {
    let valid = !bytes.is_empty()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_');
    valid.then(|| String::from_utf8_lossy(bytes).into_owned())
}

fn facts(family: u8, bytes: &[u8]) -> Option<SocketFacts> {
    let octets: [u8; 16] = bytes[..16].try_into().ok()?;
    let port = u16::from_be_bytes(bytes[16..18].try_into().ok()?);
    let address = match family {
        4 if octets[4..].iter().all(|byte| *byte == 0) => {
            std::net::IpAddr::from(<[u8; 4]>::try_from(&octets[..4]).ok()?)
        }
        6 => std::net::IpAddr::from(octets),
        _ => return None,
    };
    Some(SocketFacts { address, port })
}

fn flag(byte: u8) -> Option<bool> {
    match byte {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

fn body(kind: Kind, payload: &[u8]) -> Option<Body> {
    Some(match kind {
        Kind::BindRequest => {
            let [listener, tls, high, low, host_len, host @ ..] = payload else {
                return None;
            };
            if *host_len == 0 || host.len() != usize::from(*host_len) {
                return None;
            }
            Body::BindRequest {
                listener: Listener::from_byte(*listener)?,
                tls: flag(*tls)?,
                port: u16::from_be_bytes([*high, *low]),
                host: utf8(host)?,
            }
        }
        Kind::Bound => {
            let [listener, high, low] = payload else {
                return None;
            };
            Body::Bound {
                listener: Listener::from_byte(*listener)?,
                port: u16::from_be_bytes([*high, *low]),
            }
        }
        Kind::BindFailed => {
            let [listener, errno_len, rest @ ..] = payload else {
                return None;
            };
            let errno_len = usize::from(*errno_len);
            if errno_len > MAX_ERRNO_BYTES || rest.len() < errno_len {
                return None;
            }
            let (code, message) = rest.split_at(errno_len);
            if message.len() > MAX_MESSAGE_BYTES {
                return None;
            }
            Body::BindFailed {
                listener: Listener::from_byte(*listener)?,
                errno: errno(code)?,
                message: utf8(message)?,
            }
        }
        Kind::Accepting => Body::Accepting {
            listener: Listener::from_byte(payload[0])?,
        },
        Kind::ServiceReady => Body::ServiceReady,
        Kind::Unbind => Body::Unbind {
            listener: Listener::from_byte(payload[0])?,
        },
        Kind::Shutdown => Body::Shutdown {
            signal: Signal::from_byte(payload[0])?,
        },
        Kind::ConnOpen => {
            let (head, rest) = payload.split_at(2);
            Body::ConnOpen {
                listener: Listener::from_byte(head[0])?,
                peer: facts(head[1], &rest[..18])?,
                local: facts(head[1], &rest[18..36])?,
                encrypted: flag(rest[36])?,
            }
        }
        Kind::Data => Body::Data(payload.to_vec()),
        Kind::End => Body::End,
        Kind::Abort => Body::Abort(AbortReason::from_byte(payload[0])?),
        Kind::Credit => {
            let bytes = u32::from_be_bytes(payload.try_into().ok()?);
            if bytes == 0 {
                return None;
            }
            Body::Credit(bytes)
        }
    })
}

#[cfg(test)]
mod tests;
