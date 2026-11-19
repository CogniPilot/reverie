//! Schedule an authorized workspace task between ordinary Hands scans.
mod admission;
mod effects;
mod model;
mod receipts;
mod runner;

use super::{
    config::Config,
    state,
    view::View,
    worker::{Kind, Worker},
};
use crate::{
    coding_task::{
        admission::authorization::{Denial, Request},
        wire::Limits,
    },
    hands_chat::{Client, Operation},
    hands_settings::model_request,
    refused,
    worker_channel::remaining,
};
use model::Model;
use receipts::Claim;
use runner::Runner;
use serde_json::{Value, json};
use std::{
    io,
    time::{Duration, Instant},
};

pub(super) use admission::{Offer, offer};

#[derive(Default)]
pub(super) struct Coding {
    active: Option<Task>,
}

struct Task {
    id: String,
    room: String,
    source: Value,
    profile: String,
    claim: Claim,
    deadline: Instant,
    limits: Limits,
    messages: Vec<Value>,
    tools: Vec<Value>,
    last_progress: Instant,
    acknowledged: bool,
    worker: Option<Worker>,
    model: Option<Model>,
    pending: Option<Pending>,
}

enum Pending {
    Model(u64),
    Runner { sequence: u64, runner: Runner },
}

struct Outcome {
    result: Value,
    post: bool,
}

impl Outcome {
    fn stopped(reason: &str, post: bool) -> Self {
        Self {
            result: stopped(reason),
            post,
        }
    }
}

fn stopped(reason: &str) -> Value {
    json!({"status":"stopped","reason":reason})
}

impl Coding {
    pub(super) fn acknowledge(&mut self, receipt: &Value) {
        if let Some(job) = &mut self.active
            && receipt["room"] == job.room
            && receipt["source"] == job.source["id"]
        {
            job.acknowledged = true;
        }
    }

    pub(super) fn before_chat(&mut self) -> io::Result<()> {
        if let Some(model) = self.active.as_mut().and_then(|job| job.model.as_mut()) {
            model.pause()?;
        }
        Ok(())
    }

    pub(super) fn snapshot(cfg: &Config) -> io::Result<Option<state::Ordered>> {
        if cfg.values["coding"].is_null() {
            return Ok(None);
        }
        receipts::snapshot(&cfg.state).map(Some)
    }

    pub(super) fn stop(&mut self, cfg: &Config, reason: &str) -> io::Result<()> {
        if let Some(job) = self.active.take() {
            job.finish(cfg, Outcome::stopped(reason, false))?;
        }
        Ok(())
    }

    pub(super) fn pump(&mut self, cfg: &Config, view: &mut View, managed: &mut bool) {
        let Some(mut job) = self.active.take() else {
            return;
        };
        let outcome = match job.advance(cfg, view, managed) {
            Ok(None) => {
                self.active = Some(job);
                return;
            }
            Ok(Some(outcome)) => outcome,
            Err(_) => {
                view.log("coding controller failed");
                Outcome::stopped("controller_failed", true)
            }
        };
        if job.finish(cfg, outcome).is_err() {
            view.log("coding receipt not written");
        }
    }
}

impl Task {
    fn authorize(&self, cfg: &Config, check_cancel: bool) -> Option<&'static str> {
        self.authority(cfg, check_cancel).err().map(Denial::reason)
    }

    fn authority(&self, cfg: &Config, check_cancel: bool) -> Result<(), Denial> {
        let settings = &cfg.values;
        let session = settings["self_session_id"]
            .as_str()
            .ok_or(Denial::AuthorizationUnavailable)?;
        let timeout = settings["cli_timeout_s"]
            .as_f64()
            .ok_or(Denial::AuthorizationUnavailable)?;
        let client =
            client(cfg, timeout.min(0.75)).map_err(|_| Denial::AuthorizationUnavailable)?;
        let history_n = settings["history_n"]
            .as_u64()
            .ok_or(Denial::AuthorizationUnavailable)?;
        Request {
            config_path: Some(cfg.path.clone()),
            settings: settings["coding"].clone(),
            room: self.room.clone(),
            session: session.to_owned(),
            task: self.id.clone(),
            message: self.source.clone(),
            history_n: history_n as usize,
            expired: remaining(self.deadline).is_none(),
            check_cancel,
        }
        .check(&client)
    }

    fn start(&mut self, cfg: &Config) -> io::Result<Option<Outcome>> {
        if !self.acknowledged
            || !receipts::observed_post(&cfg.state, &self.room, &self.source["id"])?
        {
            return Ok(Some(Outcome::stopped("start_post_unconfirmed", false)));
        }
        if let Some(reason) = self.authorize(cfg, true) {
            return Ok(Some(Outcome::stopped(reason, true)));
        }
        let Some(left) = remaining(self.deadline) else {
            return Ok(Some(Outcome::stopped("time_limit", true)));
        };
        self.model = Some(Model::start(cfg)?);
        let mut limits = serde_json::to_value(&self.limits)?;
        limits["seconds"] = json!(left.as_secs_f64());
        let options = model_request(&cfg.values)["payload"].clone();
        self.worker = Some(Worker::start(
            Kind::Coding,
            &json!({
                "epoch":self.claim.epoch,"messages":self.messages,"tools":self.tools,"limits":limits,"options":options,
            }),
        )?);
        Ok(None)
    }

    fn advance(
        &mut self,
        cfg: &Config,
        view: &mut View,
        managed: &mut bool,
    ) -> io::Result<Option<Outcome>> {
        if remaining(self.deadline).is_none() {
            return Ok(Some(Outcome::stopped("time_limit", true)));
        }
        if self.worker.is_none()
            && let Some(outcome) = self.start(cfg)?
        {
            return Ok(Some(outcome));
        }
        self.resume_model(cfg, managed)?;
        if !self.collect_effect(cfg, view)? {
            return Ok(None);
        }
        let event = match self.worker.as_mut().ok_or_else(refused)?.ready() {
            Ok(Some(event)) => event,
            Ok(None) => return Ok(None),
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
                return Ok(Some(Outcome::stopped("worker_exited", true)));
            }
            Err(_) => return Ok(Some(Outcome::stopped("invalid_worker_event", true))),
        };
        if event["epoch"].as_u64() != Some(self.claim.epoch) {
            return Ok(Some(Outcome::stopped("stale_task_epoch", true)));
        }
        self.dispatch(cfg, view, managed, event)
    }

    fn resume_model(&mut self, cfg: &Config, managed: &mut bool) -> io::Result<()> {
        self.use_model(|slot, job| {
            slot.resume(|payload| model::prepare(job, cfg, managed, payload))
        })
    }

    fn use_model<T>(
        &mut self,
        action: impl FnOnce(&mut Model, &Self) -> io::Result<T>,
    ) -> io::Result<T> {
        let mut model = self.model.take().ok_or_else(refused)?;
        let result = action(&mut model, self);
        self.model = Some(model);
        result
    }

    fn dispatch(
        &mut self,
        cfg: &Config,
        view: &mut View,
        managed: &mut bool,
        mut event: Value,
    ) -> io::Result<Option<Outcome>> {
        let payload = event["payload"].take();
        let sequence = event["sequence"].as_u64();
        match event["kind"].as_str() {
            Some("result") if event["result"].is_object() => {
                return Ok(Some(Outcome {
                    result: event["result"].take(),
                    post: true,
                }));
            }
            Some("failed") => {
                return Ok(Some(Outcome::stopped(
                    event["error"].as_str().unwrap_or("worker_failed"),
                    true,
                )));
            }
            Some("authorize") => {
                self.reply(sequence, true, json!(self.authorize(cfg, true)))?;
            }
            Some("model") => {
                self.submit_model(cfg, managed, sequence.ok_or_else(refused)?, payload)?
            }
            Some("tool") => self.submit_tool(cfg, sequence.ok_or_else(refused)?, payload)?,
            Some("progress") => return self.progress(cfg, view, sequence, &payload),
            _ => return Ok(Some(Outcome::stopped("invalid_worker_event", true))),
        }
        Ok(None)
    }

    fn reply(&mut self, sequence: Option<u64>, ok: bool, result: Value) -> io::Result<()> {
        self.worker.as_mut().ok_or_else(refused)?.send(&json!({
            "epoch":self.claim.epoch,"sequence":sequence.ok_or_else(refused)?,"ok":ok,"result":result,
        }))
    }

    fn progress(
        &mut self,
        cfg: &Config,
        view: &mut View,
        sequence: Option<u64>,
        payload: &Value,
    ) -> io::Result<Option<Outcome>> {
        let tool = payload["tool"].as_str().unwrap_or("unknown");
        let ok = payload["ok"] == true;
        let step = &payload["step"];
        view.log(&format!(
            "coding step {} {} {step} {tool} {ok}",
            self.id, self.profile
        ));
        if self.last_progress.elapsed() >= Duration::from_secs(30)
            && self.authorize(cfg, false).is_none()
        {
            let status = if ok { "ok" } else { "refused or failed" };
            if self
                .say(
                    cfg,
                    format!("Task {}: step {step}, {tool}; {status}.", self.id),
                )
                .is_err()
            {
                return Ok(Some(Outcome::stopped("progress_post_failed", false)));
            }
            self.last_progress = Instant::now();
        }
        self.reply(sequence, true, Value::Null)?;
        Ok(None)
    }

    fn finish(mut self, cfg: &Config, mut outcome: Outcome) -> io::Result<()> {
        if let Some(Pending::Runner { mut runner, .. }) = self.pending.take()
            && runner.cancel().is_err()
        {
            outcome = Outcome::stopped("runner_cleanup_failed", false);
        }
        let stats = self
            .model
            .take()
            .and_then(|mut model| model.finish().ok())
            .filter(Value::is_object);
        self.worker.take();
        receipts::complete(&cfg.state, &self, &outcome.result, stats.as_ref())?;
        if outcome.post && self.authorize(cfg, false).is_none() {
            self.post_outcome(cfg, &outcome.result)?;
        }
        Ok(())
    }

    fn say(&self, cfg: &Config, text: String) -> io::Result<()> {
        let timeout = cfg.values["cli_timeout_s"].as_f64().ok_or_else(refused)?;
        let reply_to = self.source["id"].as_str().ok_or_else(refused)?;
        client(cfg, timeout)?
            .call(&Operation::Say {
                room: self.room.clone(),
                reply_to: Some(reply_to.to_owned()),
                text,
            })
            .map(|_| ())
            .map_err(|_| refused())
    }

    fn post_outcome(&self, cfg: &Config, result: &Value) -> io::Result<()> {
        let note = format_confirmation(&self.id, result);
        if self.say(cfg, note).is_err() {
            receipts::update(&cfg.state, &self.claim, |row| {
                row["final_post"] = json!("failed")
            })?;
        }
        Ok(())
    }
}

fn client(cfg: &Config, timeout: f64) -> io::Result<Client> {
    Ok(Client::new(
        serde_json::from_value(cfg.values["cli"].clone())?,
        timeout,
    ))
}

fn format_confirmation(task: &str, result: &Value) -> String {
    let status = result["status"].as_str().unwrap_or("stopped");
    let reason = result["reason"].as_str().unwrap_or("worker_failed");
    let tests = if result["tests_run"].as_u64().is_some_and(|count| count > 0) {
        let note = if result["tests_current"] == true {
            ""
        } else {
            " (no current completion, or later operations not rechecked)"
        };
        format!("exit {}{note}", result["test_exit_code"])
    } else {
        "not run".to_owned()
    };
    let edits = result["edited_paths"]
        .as_array()
        .filter(|paths| !paths.is_empty())
        .map_or_else(
            || "none recorded".into(),
            |paths| {
                paths
                    .iter()
                    .map(Value::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            },
        );
    let text = result["text"]
        .as_str()
        .filter(|text| !text.is_empty())
        .map_or_else(String::new, |text| format!("\nAgent report: {text}"));
    format!("Task {task}: {status}: {reason}.\nConfirmed edit tools: {edits}. Tests: {tests}. Full diff not independently collected.{text}").chars().take(2400).collect()
}
