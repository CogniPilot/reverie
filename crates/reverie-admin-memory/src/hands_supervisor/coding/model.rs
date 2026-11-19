//! Drive the shared model slot while ordinary chat preempts coding requests.
use super::{Config, Kind, Task, Worker};
use crate::{
    hands_prompt::estimate,
    hands_settings::{model_request, truthy},
    managed_context::{self, ContextStage},
    refused,
};
use serde_json::{Value, json, value::to_raw_value};
use std::{io, time::Duration};

pub(super) struct Model {
    worker: Worker,
    suspended: bool,
    payload: Value,
}

impl Model {
    pub(super) fn start(cfg: &Config) -> io::Result<Self> {
        let mut settings = model_request(&cfg.values);
        settings
            .as_object_mut()
            .ok_or_else(refused)?
            .remove("payload");
        settings["timeout_s"] = json!(
            cfg.values["model_timeout_s"]
                .as_f64()
                .ok_or_else(refused)?
                .min(300.0)
        );
        settings["token_meter"] = coding_meter(cfg);
        let key = settings["key_env"].as_str().map(str::to_owned);
        let mut worker = Worker::start(Kind::ModelSlot(key), &settings)?;
        match receive(&mut worker)?["kind"].as_str() {
            Some("idle") => Ok(Self {
                worker,
                suspended: false,
                payload: Value::Null,
            }),
            _ => Err(refused()),
        }
    }

    pub(super) fn submit(
        &mut self,
        remaining: Duration,
        payload: Value,
        prepare: impl FnOnce(&Value) -> io::Result<Value>,
    ) -> io::Result<()> {
        let reply = self.request(json!({"action":"submit","seconds":remaining.as_secs_f64()}))?;
        self.payload = payload;
        self.prepare(reply, prepare)
    }

    pub(super) fn pause(&mut self) -> io::Result<()> {
        if !self.suspended {
            self.request(json!({"action":"pause"}))?;
            self.suspended = true;
        }
        Ok(())
    }

    pub(super) fn resume(
        &mut self,
        prepare: impl FnOnce(&Value) -> io::Result<Value>,
    ) -> io::Result<()> {
        if self.suspended {
            let reply = self.request(json!({"action":"resume"}))?;
            self.suspended = false;
            self.prepare(reply, prepare)?;
        }
        Ok(())
    }

    fn prepare(
        &mut self,
        reply: Value,
        prepare: impl FnOnce(&Value) -> io::Result<Value>,
    ) -> io::Result<()> {
        match reply["kind"].as_str() {
            Some("idle") => Ok(()),
            Some("prepare") => {
                let payload = prepare(&self.payload).ok();
                self.request(json!({"action":"prepared","payload":payload}))?;
                Ok(())
            }
            _ => Err(refused()),
        }
    }

    pub(super) fn poll(&mut self) -> io::Result<Option<Value>> {
        if self.payload.is_null() {
            return Ok(None);
        }
        let mut reply = self.request(json!({"action":"poll"}))?;
        if reply["kind"] == "answer" {
            self.payload = Value::Null;
            return Ok(Some(reply["answer"].take()));
        }
        Ok(None)
    }

    pub(super) fn finish(&mut self) -> io::Result<Value> {
        let mut result = self.request(json!({"action":"finish"}))?;
        Ok(result["stats"].take())
    }

    fn request(&mut self, request: Value) -> io::Result<Value> {
        self.worker.send(&request)?;
        receive(&mut self.worker)
    }
}

fn receive(worker: &mut Worker) -> io::Result<Value> {
    worker.receive_as(Duration::from_secs(2), &|| Ok(()))
}

fn coding_meter(cfg: &Config) -> Value {
    let mut meter = cfg.values["coding"]["token_meter"].clone();
    if truthy(&cfg.values["vision"])
        && let Some(object) = meter.as_object_mut()
    {
        object.insert(
            "image_tokens_per_image".into(),
            cfg.values["image_tokens_per_image"].clone(),
        );
    }
    meter
}

pub(super) fn prepare(
    job: &Task,
    cfg: &Config,
    started: &mut bool,
    payload: &Value,
) -> io::Result<Value> {
    let mut request = payload.clone();
    if truthy(&cfg.values["managed_context"]) {
        inject(job, cfg, started, &mut request)?;
    }
    if job.authorize(cfg, true).is_some() {
        return Err(refused());
    }
    Ok(request)
}

fn inject(job: &Task, cfg: &Config, started: &mut bool, request: &mut Value) -> io::Result<()> {
    let tools = (!request["tools"].is_null())
        .then(|| to_raw_value(&request["tools"]))
        .transpose()?;
    let messages = request["messages"]
        .as_array_mut()
        .filter(|rows| !rows.is_empty())
        .ok_or_else(refused)?;
    let (used, _) = estimate(messages, tools.as_deref(), None)?;
    let session = cfg.values["self_session_id"].as_str().ok_or_else(refused)?;
    let stage = if *started {
        ContextStage::ModelRequest
    } else {
        ContextStage::Startup
    };
    let available = job
        .limits
        .prompt_chars
        .checked_sub(used)
        .ok_or_else(refused)?;
    let mut reply =
        managed_context::snapshot(&cfg.values["cli"], &cfg.state, session, stage, available)?;
    let snapshot = reply["snapshot"].take();
    if !snapshot.is_object() {
        return Err(refused());
    }
    *started = true;
    messages.insert(1, snapshot);
    if let Some(pending) = reply.get_mut("pending").filter(|value| !value.is_null()) {
        managed_context::acknowledge(&cfg.values["cli"], pending.take());
    }
    Ok(())
}
