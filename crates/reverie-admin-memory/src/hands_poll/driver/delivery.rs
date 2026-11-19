use super::{Pass, Target, book::State};
use crate::{
    coding_task::is_control,
    hands_poll::state::{Change, Room},
    hands_prompt::preview,
    hands_settings::truthy,
    refused,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io;

pub(super) struct Source<'a> {
    pub(super) target: &'a Target<'a>,
    pub(super) history: &'a [Value],
    pub(super) message: &'a Value,
    pub(super) id: &'a str,
}

pub(super) enum Progress {
    Marked,
    Retry,
    Leave,
}

#[derive(Deserialize)]
struct Answer {
    reply: Option<String>,
    failure: Option<String>,
    characters: Option<usize>,
    searches: Option<usize>,
    timing: Option<String>,
    coding: Option<State>,
}

impl Pass {
    pub(super) fn respond(&mut self, room: &mut Room, source: &Source<'_>) -> io::Result<Progress> {
        if self.settings.preview {
            let mut incoming = preview(source.message, self.settings.message_chars);
            incoming["room"] = json!(source.target.name);
            self.link.observe("incoming", incoming)?;
        }
        let control = self.settings.coding && is_control(source.message);
        if !control && self.settings.coordinator {
            let status: Value = self.link.exchange(json!({"effect":"before_chat"}))?;
            if let Some(detail) = status["failure"].as_str() {
                return self.failed(source, detail);
            }
        }
        let recalled = self.recall(source, control)?;
        let Answer {
            reply,
            failure,
            characters,
            searches,
            timing,
            coding,
        } = self.link.exchange(json!({
            "effect":"answer", "room":source.target.id, "recalled":recalled,
            "history":source.history, "message":source.message, "control":control,
            "direct":self.is_direct(source.target),
        }))?;
        if let Some(coding) = coding {
            self.book.coding(coding);
        }
        let Some(reply) = reply.as_deref().filter(|reply| !reply.is_empty()) else {
            return self.failed(source, failure.as_deref().unwrap_or("empty reply"));
        };
        let span = Reply {
            text: reply,
            characters: characters.ok_or_else(refused)?,
            searches: searches.ok_or_else(refused)?,
            timing: timing.as_deref().ok_or_else(refused)?,
        };
        self.post(room, source, span)
    }

    fn recall(&mut self, source: &Source<'_>, control: bool) -> io::Result<String> {
        if control || self.is_direct(source.target) {
            return Ok(String::new());
        }
        let text = source.message["text"].as_str().unwrap_or_default();
        let query = truncate(text, self.settings.message_chars);
        self.memory.recall(&mut self.link, source.target.id, query)
    }

    fn post(
        &mut self,
        room: &mut Room,
        source: &Source<'_>,
        answer: Reply<'_>,
    ) -> io::Result<Progress> {
        let id = source.id.to_owned();
        let target = source.target.id;
        if !self.is_member(target)? {
            self.link
                .log(json!(["answer dropped: no longer a member", target, id]))?;
            room.apply(Change::Complete { id })?;
            self.book.complete_left(target, room, &mut self.link)?;
            return Ok(Progress::Leave);
        }
        if !self.office.allowed(&mut self.link, source)? {
            self.change(target, room, Change::Complete { id })?;
            return Ok(Progress::Marked);
        }
        let sent = truncate(answer.text, self.settings.reply_chars);
        self.link.observe("posting", json!({}))?;
        let receipt = match self.office.say(&mut self.link, source, sent)? {
            Ok(receipt) => receipt,
            Err(error) => return self.failed(source, &error.detail),
        };
        self.change(target, room, Change::Complete { id })?;
        if self.settings.coordinator && receipt["id"].as_str().is_some_and(|id| !id.is_empty()) {
            self.link
                .tell(json!({"coding_post":{"room":target,"source":source.id}}))?;
        }
        self.posted += 1;
        self.receipt(source, &receipt, sent, answer)
    }

    fn is_member(&mut self, room: &str) -> io::Result<bool> {
        if self.settings.rooms.is_some() {
            return Ok(true);
        }
        match self.office.rooms(&mut self.link)? {
            Ok(rooms) => Ok(rooms.iter().any(|row| row["id"].as_str() == Some(room))),
            Err(error) => {
                self.link
                    .log(json!(["membership check failed", room, error.detail]))?;
                Ok(false)
            }
        }
    }

    fn receipt(
        &mut self,
        source: &Source<'_>,
        receipt: &Value,
        sent: &str,
        answer: Reply<'_>,
    ) -> io::Result<Progress> {
        let id = &receipt["id"];
        self.link.observe(
            "reply",
            json!({
                "room":source.target.name, "text":sent, "confirmed":truthy(id),
            }),
        )?;
        if truthy(id) && !self.is_direct(source.target) {
            let text = source.message["text"].as_str().unwrap_or_default();
            self.memory.record(
                &mut self.link,
                source.target.id,
                json!({
                    "source":source.id, "at":source.message.get("at").cloned().unwrap_or(json!(0)),
                    "text":truncate(text,self.settings.message_chars), "reply":sent, "reply_id":id
                }),
            )?;
        }
        let characters = format!("request_chars={}", answer.characters);
        let reply_chars = format!("reply_chars={}", answer.text.chars().count());
        let searches = format!("searches={}", answer.searches);
        let timing = format!("timing={}", answer.timing);
        self.link.log(json!([
            "answered",
            source.target.id,
            source.id,
            characters,
            reply_chars,
            searches,
            timing
        ]))?;
        Ok(Progress::Marked)
    }

    fn failed(&mut self, source: &Source<'_>, detail: &str) -> io::Result<Progress> {
        self.link.log(json!([
            "answer failed",
            source.target.id,
            source.id,
            detail
        ]))?;
        // Keep the durable claim for the original one-retry settlement.
        Ok(Progress::Retry)
    }
}

struct Reply<'a> {
    text: &'a str,
    characters: usize,
    searches: usize,
    timing: &'a str,
}

fn truncate(text: &str, limit: usize) -> &str {
    let end = text
        .char_indices()
        .nth(limit)
        .map_or(text.len(), |(index, _)| index);
    &text[..end]
}
