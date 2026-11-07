//! Existing broker wire-v1 envelope DATA shared by actual native consumers.
//! A decoded header is not an authorized operation or a validated payload.
//! G's bare-byte streaming fast path and each purpose's smaller limit are
//! separate; no protocol, command, flag or peer-authentication policy is added.
pub const MAX_FRAME: usize = 262_144;
pub const HEADER_BYTES: usize = 5;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WorkerFrameHeader {
    kind: u8,
    length: u32,
}
impl WorkerFrameHeader {
    /// A normal outgoing frame obeys the original common byte bound.
    pub fn for_payload(kind: u8, length: usize) -> Option<Self> {
        (length <= MAX_FRAME).then(|| Self {
            kind,
            length: u32::try_from(length).expect("256KiB fits wire u32"),
        })
    }
    /// Decode only the five-byte syntax. The caller MUST enforce its actual
    /// incoming purpose/common bound before allocating/reading the payload.
    pub fn decode(raw: [u8; HEADER_BYTES]) -> Self {
        Self {
            kind: raw[0],
            length: u32::from_be_bytes([raw[1], raw[2], raw[3], raw[4]]),
        }
    }
    pub fn encode(self) -> [u8; HEADER_BYTES] {
        let bytes = self.length.to_be_bytes();
        [self.kind, bytes[0], bytes[1], bytes[2], bytes[3]]
    }
    pub fn kind(self) -> u8 {
        self.kind
    }
    pub fn payload_length(self) -> u32 {
        self.length
    }
}
