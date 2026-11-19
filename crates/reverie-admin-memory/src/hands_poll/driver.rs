//! Run one serial Hands poll using the same wake policy and durable claim file.
mod book;
mod delivery;
mod memory;
mod office;

use self::{
    book::Book,
    delivery::{Progress, Source},
    office::Office,
};
use super::{
    rooms,
    state::{Change, Room},
};
use crate::{
    TURN_CAPTURE_BOUND, hands_addressing::Scope, hands_chat::Client, refused,
    worker_channel::WorkerChannel,
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Number, Value, json};
use std::{
    collections::HashSet,
    io,
    path::PathBuf,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    office: Option<Client>,
    #[serde(default)]
    memory: memory::Memory,
    state: book::State,
    path: PathBuf,
    settings: Settings,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    rooms: Option<Vec<String>>,
    dm_rooms: Vec<String>,
    name: Option<String>,
    session: Option<String>,
    max_rooms: usize,
    history_n: usize,
    max_answers: usize,
    reply_chars: usize,
    message_chars: usize,
    #[serde(default)]
    coding: bool,
    #[serde(default)]
    coordinator: bool,
    #[serde(default)]
    preview: bool,
}

struct Pass {
    book: Book,
    office: Office,
    memory: memory::Memory,
    settings: Settings,
    link: Link,
    posted: usize,
}

struct Target<'a> {
    id: &'a str,
    name: &'a str,
    latest: Option<&'a str>,
    direct: bool,
}

struct Link(WorkerChannel);

impl Link {
    fn tell(&mut self, event: Value) -> io::Result<()> {
        self.0
            .write_bounded(&event, Some(deadline()), TURN_CAPTURE_BOUND)
    }

    fn exchange<T: DeserializeOwned>(&mut self, event: Value) -> io::Result<T> {
        self.tell(event)?;
        // The parent owns the deadline of the already-bounded compatibility
        // callback, including replies with multiple model steps.
        self.0
            .read_bounded(None, TURN_CAPTURE_BOUND)?
            .ok_or_else(refused)
    }

    fn log(&mut self, parts: Value) -> io::Result<()> {
        self.tell(json!({"log":parts}))
    }

    fn observe(&mut self, kind: &str, data: Value) -> io::Result<()> {
        self.tell(json!({"observe":kind,"data":data}))
    }
}

pub(crate) fn run_tick(parent: i32) -> io::Result<()> {
    crate::bind_worker(parent)?;
    let mut channel = WorkerChannel::open()?;
    let job: Job = channel
        .read_bounded(Some(deadline()), TURN_CAPTURE_BOUND)?
        .ok_or_else(refused)?;
    let mut pass = Pass {
        book: Book::new(job.path, job.state),
        office: Office::new(job.office),
        memory: job.memory,
        settings: job.settings,
        link: Link(channel),
        posted: 0,
    };
    let result = match pass.run() {
        Ok(()) => json!({"posted":pass.posted}),
        Err(error) => json!({"error":error.to_string()}),
    };
    pass.link.tell(result)
}

impl Pass {
    fn run(&mut self) -> io::Result<()> {
        match self.settings.rooms.clone() {
            Some(fixed) => {
                for id in &fixed {
                    self.room(Target {
                        id,
                        name: id,
                        latest: None,
                        direct: false,
                    })?;
                }
                Ok(())
            }
            None => self.discover(),
        }
    }

    fn discover(&mut self) -> io::Result<()> {
        let listed = match self.office.rooms(&mut self.link)? {
            Ok(listed) => listed,
            Err(error) => return self.link.tell(json!({"room_list":{"error":error.name}})),
        };
        self.link.tell(json!({"room_list":{"error":null}}))?;
        let before = self.book.value("_auto_rooms");
        let listing = rooms::reconcile(
            &listed,
            before.as_array().map(Vec::as_slice),
            |id| self.book.value(id),
            self.settings.max_rooms,
        );
        self.update_listing(&listing)?;
        for row in listing.rooms.iter().filter(|room| room.read) {
            self.room(Target {
                id: row.id,
                name: row.name,
                latest: row.latest,
                direct: row.direct,
            })?;
        }
        Ok(())
    }

    fn update_listing(&mut self, listing: &rooms::Selection<'_>) -> io::Result<()> {
        if listing.total > self.settings.max_rooms {
            self.link.log(json!([
                "room list capped",
                listing.total,
                "of",
                self.settings.max_rooms
            ]))?;
        }
        self.link
            .observe("rooms", json!({"count":listing.rooms.len()}))?;
        if !listing.joined.is_empty() || listing.left != 0 {
            self.link.log(json!([
                "rooms changed",
                "joined",
                listing.joined.len(),
                "left",
                listing.left,
                "now",
                listing.rooms.len()
            ]))?;
        }
        self.book.listing(listing, &mut self.link)
    }

    fn room(&mut self, target: Target<'_>) -> io::Result<()> {
        let history =
            match self
                .office
                .history(&mut self.link, target.id, self.settings.history_n)?
            {
                Ok(history) => history,
                Err(error) => {
                    return self
                        .link
                        .log(json!(["read failed", target.id, error.detail]));
                }
            };
        if let Some(zone) = history.zone {
            self.link.tell(json!({"time_zone":zone}))?;
        }
        let mut room = match self.book.room(target.id) {
            Ok(room) => room,
            Err(_) => {
                return self
                    .link
                    .log(json!(["room scan failed", target.id, "ValueError"]));
            }
        };
        let latest = target.latest.map(str::to_owned);
        if room.initialize(&history.rows, latest.clone()) {
            self.book.update_room(target.id, &room, &mut self.link)?;
            let note = format!(
                "Following {}; {} existing messages skipped.",
                target.name,
                history.rows.len()
            );
            return self.link.observe("note", json!({"text":note}));
        }
        self.settle(target.id, &mut room)?;
        self.pending(&target, &mut room, &history.rows)
    }

    fn settle(&mut self, id: &str, room: &mut Room) -> io::Result<()> {
        let Some(session) = self.settings.session.clone() else {
            return Ok(());
        };
        let sources = room.claim_ids();
        for source in sources {
            let view = match self
                .office
                .history(&mut self.link, id, self.settings.history_n)?
            {
                Ok(view) => view,
                Err(error) => {
                    self.link
                        .log(json!(["claim check failed", id, source, error.name]))?;
                    continue;
                }
            };
            if let Some(disposition) = room
                .claim(&source)
                .and_then(|claim| claim.disposition(&session, &view.rows))
            {
                let label = format!("claim {}", disposition.as_str());
                self.link.log(json!([label, id, source]))?;
                self.change(id, room, Change::Complete { id: source })?;
            }
        }
        Ok(())
    }

    fn pending(
        &mut self,
        target: &Target<'_>,
        room: &mut Room,
        history: &[Value],
    ) -> io::Result<()> {
        let scope = Scope {
            session: self.settings.session.clone(),
            name: self.settings.name.clone(),
            direct: self.is_direct(target),
        };
        let mut seen = HashSet::new();
        for (index, wake) in room.pending(&scope, history) {
            let message = &history[index];
            let id = message["id"].as_str().ok_or_else(refused)?;
            if seen.contains(id) {
                continue;
            }
            if wake && self.posted >= self.settings.max_answers {
                return Ok(());
            }
            match self.message(
                room,
                Source {
                    target,
                    history,
                    message,
                    id,
                },
                wake,
            )? {
                Progress::Marked => {
                    seen.insert(id);
                }
                Progress::Retry => {}
                Progress::Leave => return Ok(()),
            }
        }
        self.change(
            target.id,
            room,
            Change::Advance {
                latest: target.latest.map(str::to_owned),
            },
        )
    }

    fn is_direct(&self, target: &Target<'_>) -> bool {
        target.direct || self.settings.dm_rooms.iter().any(|id| id == target.id)
    }

    fn message(&mut self, room: &mut Room, source: Source<'_>, wake: bool) -> io::Result<Progress> {
        let id = source.id.to_owned();
        let target = source.target.id;
        if !wake {
            self.change(target, room, Change::Skip { id })?;
            return Ok(Progress::Marked);
        }
        if !self.office.allowed(&mut self.link, &source)? {
            self.change(target, room, Change::Complete { id })?;
            return Ok(Progress::Marked);
        }
        let msg_at = source.message["at"]
            .as_number()
            .cloned()
            .unwrap_or_else(|| Number::from(0));
        self.change(target, room, Change::Claim { id, msg_at })?;
        self.respond(room, &source)
    }

    fn change(&mut self, id: &str, room: &mut Room, change: Change) -> io::Result<()> {
        room.apply(change)?;
        self.book.update_room(id, room, &mut self.link)
    }
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
