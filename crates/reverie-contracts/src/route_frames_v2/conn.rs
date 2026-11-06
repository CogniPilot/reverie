//! Per-connection ordering on one side of the channel, as a pure state machine.
//!
//! Each side keeps its open connections and `next_id`, the id after the highest the front has
//! opened. Ids are monotone and never reused in a generation, so any id below `next_id` that is
//! not open is closed, and a late frame for it is settled and dropped without a tombstone set.
//! A connection closes on `abort` from either side; an `abort` that crosses one already sent or
//! received is normal. Without an abort it closes once both directions have ended *and* the front
//! has reported, in `written`, every TS→front stream byte as accepted by the OS. Until then it
//! drains, so the receipt that finishes TS's last write still has an open connection to land on.
use super::MAX_STREAM_BYTES;
use std::collections::BTreeMap;

/// A frame that breaks the connection rules. Like a frame error, it ends the generation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnFault {
    /// A frame names an id the front never opened, or `conn_open` skips or repeats an id.
    Unopened,
    /// `data` after the sender's `end`, or a second `end`.
    AfterEnd,
    /// The front is at its connection bound.
    Full,
    /// A `written` that does not advance, that passes the stream bytes, or that this side may not
    /// receive or send.
    Written,
    /// TS→front `data` past [`MAX_STREAM_BYTES`] on one connection.
    StreamBound,
}
impl ConnFault {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unopened => "CONN_UNOPENED",
            Self::AfterEnd => "CONN_AFTER_END",
            Self::Full => "CONN_FULL",
            Self::Written => "CONN_WRITTEN",
            Self::StreamBound => "CONN_STREAM_BOUND",
        }
    }
}

/// What a received connection frame means once the rules are applied.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Received {
    Opened,
    /// Deliver these bytes to the connection.
    Data(usize),
    /// The peer ended its direction; `closed` when ours had ended too.
    Ended {
        closed: bool,
    },
    Aborted,
    Credit(u32),
    /// The front reports this many stream bytes accepted; `closed` when that drained the connection.
    Written {
        bytes: u64,
        closed: bool,
    },
    /// For a closed connection: drop it, releasing `data` bytes to the pool.
    Late {
        data: usize,
    },
}

/// A connection frame, as the rules see it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnFrame {
    Open,
    Data(usize),
    End,
    Abort,
    Credit(u32),
    Written(u64),
}

/// Which end of the channel a table belongs to. The TS→front stream is the one `written` counts:
/// TS sends its bytes and receives the receipts, the front receives the bytes and sends them.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Side {
    Front,
    Ts,
}

#[derive(Clone, Copy, Debug, Default)]
struct Ends {
    local: bool,
    remote: bool,
    /// TS→front `data` bytes so far.
    stream: u64,
    /// The last `written`.
    written: u64,
}

impl Ends {
    fn closed(&self) -> bool {
        self.local && self.remote && self.written == self.stream
    }
    /// Counts `bytes` more of the TS→front stream.
    fn carry(&mut self, bytes: usize) -> Result<(), ConnFault> {
        self.stream = self
            .stream
            .checked_add(bytes as u64)
            .filter(|total| *total <= MAX_STREAM_BYTES)
            .ok_or(ConnFault::StreamBound)?;
        Ok(())
    }
    /// Records a receipt for the TS→front stream.
    fn receipt(&mut self, bytes: u64) -> Result<(), ConnFault> {
        if bytes <= self.written || bytes > self.stream {
            return Err(ConnFault::Written);
        }
        self.written = bytes;
        Ok(())
    }
}

#[derive(Debug)]
pub struct ConnTable {
    side: Side,
    next_id: u64,
    max_open: usize,
    open: BTreeMap<u64, Ends>,
}

impl ConnTable {
    pub fn new(side: Side, max_open: usize) -> Self {
        Self {
            side,
            next_id: 1,
            max_open,
            open: BTreeMap::new(),
        }
    }

    pub fn open_count(&self) -> usize {
        self.open.len()
    }

    /// The front opens its next connection; the caller then sends `conn_open` with this id.
    pub fn open_next(&mut self) -> Result<u64, ConnFault> {
        if self.open.len() >= self.max_open {
            return Err(ConnFault::Full);
        }
        let id = self.next_id;
        self.next_id += 1;
        self.open.insert(id, Ends::default());
        Ok(id)
    }

    /// Applies a frame received for `id`.
    pub fn receive(&mut self, id: u64, frame: ConnFrame) -> Result<Received, ConnFault> {
        if frame == ConnFrame::Open {
            return self.accept_open(id);
        }
        if frame == ConnFrame::Abort && self.open.remove(&id).is_some() {
            return Ok(Received::Aborted);
        }
        let Some(ends) = self.open.get_mut(&id) else {
            return self.late(id, frame);
        };
        let received = match frame {
            ConnFrame::Data(_) | ConnFrame::End if ends.remote => return Err(ConnFault::AfterEnd),
            ConnFrame::Data(bytes) => {
                if self.side == Side::Front {
                    ends.carry(bytes)?;
                }
                Received::Data(bytes)
            }
            ConnFrame::End => {
                ends.remote = true;
                Received::Ended {
                    closed: ends.closed(),
                }
            }
            ConnFrame::Written(_) if self.side == Side::Front => return Err(ConnFault::Written),
            ConnFrame::Written(bytes) => {
                ends.receipt(bytes)?;
                Received::Written {
                    bytes,
                    closed: ends.closed(),
                }
            }
            ConnFrame::Credit(bytes) => Received::Credit(bytes),
            ConnFrame::Open | ConnFrame::Abort => unreachable!("handled above"),
        };
        if ends.closed() {
            self.open.remove(&id);
        }
        Ok(received)
    }

    /// Checks a frame this side is about to send for `id`. `Ok(false)` means the connection has
    /// already closed (a crossing `abort`), so the frame is not sent.
    ///
    /// `written` is the exception. The front calls this for it only after the complete encoded frame
    /// has been written to the channel, never when it is queued or partly written: the receipt that
    /// drains a connection closes it, so calling earlier could close the connection on a receipt that
    /// never reaches TS. So for `written`, `Ok(false)` cannot mean "not sent": an abort closed the id
    /// while the frame was finishing, the frame has crossed anyway, and TS settles it as a late frame.
    pub fn send(&mut self, id: u64, frame: ConnFrame) -> Result<bool, ConnFault> {
        if frame == ConnFrame::Abort && self.open.remove(&id).is_some() {
            return Ok(true);
        }
        let Some(ends) = self.open.get_mut(&id) else {
            return if id < self.next_id {
                Ok(false)
            } else {
                Err(ConnFault::Unopened)
            };
        };
        match frame {
            ConnFrame::Open => return Err(ConnFault::Unopened),
            ConnFrame::Data(_) | ConnFrame::End if ends.local => return Err(ConnFault::AfterEnd),
            ConnFrame::Data(bytes) if self.side == Side::Ts => ends.carry(bytes)?,
            ConnFrame::End => ends.local = true,
            ConnFrame::Abort => unreachable!("handled above"),
            ConnFrame::Written(_) if self.side == Side::Ts => return Err(ConnFault::Written),
            ConnFrame::Written(bytes) => ends.receipt(bytes)?,
            ConnFrame::Data(_) | ConnFrame::Credit(_) => {}
        }
        if ends.closed() {
            self.open.remove(&id);
        }
        Ok(true)
    }

    fn accept_open(&mut self, id: u64) -> Result<Received, ConnFault> {
        if id != self.next_id {
            return Err(ConnFault::Unopened);
        }
        if self.open.len() >= self.max_open {
            return Err(ConnFault::Full);
        }
        self.next_id += 1;
        self.open.insert(id, Ends::default());
        Ok(Received::Opened)
    }

    fn late(&self, id: u64, frame: ConnFrame) -> Result<Received, ConnFault> {
        if id >= self.next_id {
            return Err(ConnFault::Unopened);
        }
        Ok(Received::Late {
            data: match frame {
                ConnFrame::Data(bytes) => bytes,
                _ => 0,
            },
        })
    }
}
