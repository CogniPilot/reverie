//! Long-poll the scoped Office phone and send only wake signals to Hands.
mod phone;

use crate::worker_channel::WorkerChannel;
use phone::{Event, Phone, Poll};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashSet, VecDeque},
    io,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
struct Start {
    endpoint: Option<String>,
    worker: Option<String>,
    parent_session: Option<String>,
    session: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Unscoped,
    Active,
    OfficeDisabled,
    Unavailable,
}

#[derive(Serialize)]
struct Notice {
    status: Status,
    wake: bool,
}

const RETRY_MIN: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const SEEN_LIMIT: usize = 500;

struct Listener {
    channel: WorkerChannel,
    status: Option<Status>,
    seen: HashSet<Event>,
    order: VecDeque<Event>,
    retry: Duration,
}

impl Listener {
    fn new(channel: WorkerChannel) -> Self {
        Self {
            channel,
            status: None,
            seen: HashSet::new(),
            order: VecDeque::new(),
            retry: RETRY_MIN,
        }
    }

    fn notify(&mut self, status: Status, wake: bool) -> io::Result<()> {
        if wake || self.status != Some(status) {
            let deadline = Instant::now() + Duration::from_millis(500);
            self.channel
                .write(&Notice { status, wake }, Some(deadline))?;
            self.status = Some(status);
        }
        Ok(())
    }

    fn accept(&mut self, poll: Poll) -> io::Result<Duration> {
        let status = match poll {
            Poll::Active(event) => {
                let wake =
                    event.is_some_and(|event| remember(&mut self.seen, &mut self.order, event));
                self.notify(Status::Active, wake)?;
                self.retry = RETRY_MIN;
                return Ok(POLL_INTERVAL);
            }
            Poll::Disabled => Status::OfficeDisabled,
            Poll::Unavailable => Status::Unavailable,
        };
        self.notify(status, false)?;
        let delay = self.retry;
        self.retry = (2 * delay).min(RETRY_MAX);
        Ok(delay)
    }
}

fn remember(seen: &mut HashSet<Event>, order: &mut VecDeque<Event>, event: Event) -> bool {
    if !seen.insert(event.clone()) {
        return false;
    }
    order.push_back(event);
    if order.len() > SEEN_LIMIT {
        seen.remove(&order.pop_front().expect("nonempty wake history"));
    }
    true
}

pub(crate) fn run(expected_parent: i32) -> io::Result<()> {
    crate::bind_worker(expected_parent)?;
    let mut channel = WorkerChannel::open()?;
    let Some(start) = channel.read::<Start>(Some(Instant::now() + RETRY_MIN))? else {
        return Ok(());
    };
    let mut listener = Listener::new(channel);
    let Some(phone) = Phone::bind(start) else {
        return listener.notify(Status::Unscoped, false);
    };
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async move {
            loop {
                let delay = listener.accept(phone.poll().await)?;
                tokio::time::sleep(delay).await;
            }
        })
}

#[cfg(test)]
mod tests {
    use super::{Event, SEEN_LIMIT, remember};
    use std::collections::{HashSet, VecDeque};

    #[test]
    fn duplicate_wakes_are_suppressed_until_the_oldest_distinct_pair_is_evicted() {
        let mut seen = HashSet::new();
        let mut order = VecDeque::new();
        let event = |room: usize| Event::fixture(room.to_string(), "message".into());
        assert!(remember(&mut seen, &mut order, event(0)));
        assert!(!remember(&mut seen, &mut order, event(0)));
        for room in 1..=SEEN_LIMIT {
            assert!(remember(&mut seen, &mut order, event(room)));
        }
        assert_eq!(seen.len(), SEEN_LIMIT);
        assert_eq!(order.len(), SEEN_LIMIT);
        assert!(remember(&mut seen, &mut order, event(0)));
    }
}
