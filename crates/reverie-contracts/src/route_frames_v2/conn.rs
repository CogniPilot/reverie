//! Per-connection ordering on one side of the channel, as a pure state machine.
//!
//! Each side keeps its open connections and `next_id`, the id after the highest the front has
//! opened. Ids are monotone and never reused in a generation, so any id below `next_id` that is
//! not open is closed, and a late frame for it is settled and dropped without a tombstone set.
//! A connection closes when both directions have ended, or on `abort` from either side; an
//! `abort` that crosses one already sent or received is normal.
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
}
impl ConnFault {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unopened => "CONN_UNOPENED",
            Self::AfterEnd => "CONN_AFTER_END",
            Self::Full => "CONN_FULL",
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
}

#[derive(Clone, Copy, Debug, Default)]
struct Ends {
    local: bool,
    remote: bool,
}

#[derive(Debug)]
pub struct ConnTable {
    next_id: u64,
    max_open: usize,
    open: BTreeMap<u64, Ends>,
}

impl ConnTable {
    pub fn new(max_open: usize) -> Self {
        Self {
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
        let Some(ends) = self.open.get_mut(&id) else {
            return self.late(id, frame);
        };
        match frame {
            ConnFrame::Data(_) | ConnFrame::End if ends.remote => Err(ConnFault::AfterEnd),
            ConnFrame::Data(bytes) => Ok(Received::Data(bytes)),
            ConnFrame::End => {
                ends.remote = true;
                let closed = ends.local;
                if closed {
                    self.open.remove(&id);
                }
                Ok(Received::Ended { closed })
            }
            ConnFrame::Abort => {
                self.open.remove(&id);
                Ok(Received::Aborted)
            }
            ConnFrame::Credit(bytes) => Ok(Received::Credit(bytes)),
            ConnFrame::Open => unreachable!("handled above"),
        }
    }

    /// Checks a frame this side is about to send for `id`. `Ok(false)` means the connection has
    /// already closed (a crossing `abort`), so the frame is not sent.
    pub fn send(&mut self, id: u64, frame: ConnFrame) -> Result<bool, ConnFault> {
        let Some(ends) = self.open.get_mut(&id) else {
            return if id < self.next_id {
                Ok(false)
            } else {
                Err(ConnFault::Unopened)
            };
        };
        match frame {
            ConnFrame::Open => Err(ConnFault::Unopened),
            ConnFrame::Data(_) | ConnFrame::End if ends.local => Err(ConnFault::AfterEnd),
            ConnFrame::End => {
                ends.local = true;
                if ends.remote {
                    self.open.remove(&id);
                }
                Ok(true)
            }
            ConnFrame::Abort => {
                self.open.remove(&id);
                Ok(true)
            }
            ConnFrame::Data(_) | ConnFrame::Credit(_) => Ok(true),
        }
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
