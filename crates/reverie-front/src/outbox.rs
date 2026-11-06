//! Bounded priority controls and fair ordered streams for one generation.
//! A pending data packet owns its issued bytes until the channel writer drops it.
use crate::budget::{BudgetError, ByteLease};
use reverie_contracts::route_frames_v2::{Body, Direction, Frame, FrameError, MAX_DATA_BYTES};
use std::collections::{BTreeMap, VecDeque};

#[derive(Debug)]
pub enum QueueError {
    Frame(FrameError),
    Budget(BudgetError),
    Charge,
    ControlFull,
    CreditOverflow,
    ReceiptOrder,
    AfterEnd,
}
impl std::fmt::Display for QueueError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "{self:?}")
    }
}
impl std::error::Error for QueueError {}

#[derive(Debug)]
pub struct ChargedData {
    bytes: Vec<u8>,
    lease: ByteLease,
}
impl ChargedData {
    pub fn new(bytes: Vec<u8>, lease: ByteLease) -> Result<Self, QueueError> {
        if bytes.is_empty() || bytes.len() > MAX_DATA_BYTES || bytes.len() != lease.bytes() {
            return Err(QueueError::Charge);
        }
        // A short TCP read must not retain its original 64 KiB allocation while
        // charging only one byte. Box conversion gives the retained Vec exactly
        // its payload capacity, including caller-supplied overallocated buffers.
        let bytes = bytes.into_boxed_slice().into_vec();
        Ok(Self { bytes, lease })
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn into_parts(self) -> (Vec<u8>, ByteLease) {
        (self.bytes, self.lease)
    }
}

#[derive(Debug)]
pub enum StreamPacket {
    Data(ChargedData),
    End,
}
#[derive(Debug, Default)]
pub struct StreamQueue {
    packets: VecDeque<StreamPacket>,
    ended: bool,
}
impl StreamQueue {
    pub fn push(&mut self, packet: StreamPacket) -> Result<(), QueueError> {
        if self.ended {
            return Err(QueueError::AfterEnd);
        }
        match packet {
            StreamPacket::End => {
                self.ended = true;
                self.packets.push_back(StreamPacket::End);
            }
            StreamPacket::Data(data) => self.push_data(data)?,
        }
        Ok(())
    }
    fn push_data(&mut self, mut next: ChargedData) -> Result<(), QueueError> {
        if let Some(StreamPacket::Data(previous)) = self.packets.back_mut() {
            let take = next.bytes.len().min(MAX_DATA_BYTES - previous.bytes.len());
            if let Some(amount) = std::num::NonZeroU32::new(take as u32) {
                let lease = next.lease.split(amount).map_err(QueueError::Budget)?;
                previous.lease.merge(lease).map_err(QueueError::Budget)?;
                previous.bytes.reserve_exact(take);
                previous.bytes.extend_from_slice(&next.bytes[..take]);
                next.bytes.drain(..take);
                next.bytes = next.bytes.into_boxed_slice().into_vec();
            }
        }
        if !next.bytes.is_empty() {
            self.packets.push_back(StreamPacket::Data(next));
        }
        Ok(())
    }
    pub fn pop(&mut self) -> Option<StreamPacket> {
        self.packets.pop_front()
    }
    pub fn is_empty(&self) -> bool {
        self.packets.is_empty()
    }
    pub fn ended(&self) -> bool {
        self.ended
    }
}

/// The writer must retain this owner through write completion, including errors.
#[derive(Debug)]
pub struct QueuedFrame {
    frame: Frame,
    _lease: Option<ByteLease>,
}
impl QueuedFrame {
    pub fn frame(&self) -> &Frame {
        &self.frame
    }
    pub fn encode(&self) -> Result<Vec<u8>, FrameError> {
        self.frame.encode(Direction::ToTs)
    }
}
#[derive(Debug)]
pub struct Outbox {
    generation: u64,
    controls: VecDeque<Frame>,
    control_bytes: usize,
    control_limit: usize,
    streams: BTreeMap<u64, StreamQueue>,
    ready: VecDeque<u64>,
}
impl Outbox {
    pub fn new(generation: std::num::NonZeroU64, control_limit: usize) -> Self {
        Self {
            generation: generation.get(),
            controls: VecDeque::new(),
            control_bytes: 0,
            control_limit,
            streams: BTreeMap::new(),
            ready: VecDeque::new(),
        }
    }
    pub fn control_bytes(&self) -> usize {
        self.control_bytes
    }
    pub fn control(&mut self, id: u64, body: Body) -> Result<(), QueueError> {
        if matches!(body, Body::Data(_) | Body::End) {
            return Err(QueueError::Charge);
        }
        let frame = Frame {
            generation: self.generation,
            id,
            body,
        };
        let bytes = frame
            .encode(Direction::ToTs)
            .map_err(QueueError::Frame)?
            .len();
        if let Body::Credit(amount) = frame.body
            && self.coalesce_credit(id, amount)?
        {
            return Ok(());
        }
        if let Body::Written(total) = frame.body
            && self.coalesce_written(id, total)?
        {
            return Ok(());
        }
        if bytes > self.control_limit.saturating_sub(self.control_bytes) {
            return Err(QueueError::ControlFull);
        }
        if matches!(frame.body, Body::Abort(_)) {
            self.discard_connection(id);
        }
        self.control_bytes += bytes;
        self.controls.push_back(frame);
        Ok(())
    }
    fn coalesce_credit(&mut self, id: u64, amount: u32) -> Result<bool, QueueError> {
        let pending = self
            .controls
            .iter_mut()
            .find_map(|frame| match &mut frame.body {
                Body::Credit(bytes) if frame.id == id => Some(bytes),
                _ => None,
            });
        let Some(pending) = pending else {
            return Ok(false);
        };
        *pending = pending
            .checked_add(amount)
            .ok_or(QueueError::CreditOverflow)?;
        Ok(true)
    }
    fn coalesce_written(&mut self, id: u64, total: u64) -> Result<bool, QueueError> {
        let pending = self
            .controls
            .iter_mut()
            .find_map(|frame| match &mut frame.body {
                Body::Written(value) if frame.id == id => Some(value),
                _ => None,
            });
        let Some(pending) = pending else {
            return Ok(false);
        };
        if total <= *pending {
            return Err(QueueError::ReceiptOrder);
        }
        *pending = total;
        Ok(true)
    }
    pub fn stream(&mut self, id: u64, packet: StreamPacket) -> Result<(), QueueError> {
        let queue = self.streams.entry(id).or_default();
        let was_empty = queue.is_empty();
        queue.push(packet)?;
        if was_empty {
            self.ready.push_back(id);
        }
        Ok(())
    }
    pub fn discard_stream(&mut self, id: u64) {
        self.streams.remove(&id);
        self.ready.retain(|queued| *queued != id);
    }
    /// Abort can discard a queued receipt, never a frame already owned by the
    /// channel writer. Normal retirement waits for that writer's completion.
    pub fn discard_connection(&mut self, id: u64) {
        self.discard_stream(id);
        self.controls.retain(|frame| {
            if frame.id == id && matches!(frame.body, Body::Written(_)) {
                self.control_bytes -= frame
                    .encode(Direction::ToTs)
                    .expect("validated receipt")
                    .len();
                false
            } else {
                true
            }
        });
    }
    pub fn has_stream(&self, id: u64) -> bool {
        self.streams.contains_key(&id)
    }
    pub fn pop(&mut self) -> Option<QueuedFrame> {
        if let Some(frame) = self.controls.pop_front() {
            self.control_bytes -= frame
                .encode(Direction::ToTs)
                .expect("validated control")
                .len();
            return Some(QueuedFrame {
                frame,
                _lease: None,
            });
        }
        let id = self.ready.pop_front()?;
        let queue = self.streams.get_mut(&id).expect("ready stream");
        let packet = queue.pop().expect("nonempty stream");
        if queue.is_empty() {
            self.streams.remove(&id);
        } else {
            self.ready.push_back(id);
        }
        let (body, lease) = match packet {
            StreamPacket::Data(data) => {
                let (bytes, lease) = data.into_parts();
                (Body::Data(bytes), Some(lease))
            }
            StreamPacket::End => (Body::End, None),
        };
        Some(QueuedFrame {
            frame: Frame {
                generation: self.generation,
                id,
                body,
            },
            _lease: lease,
        })
    }
}

#[cfg(test)]
mod tests;
