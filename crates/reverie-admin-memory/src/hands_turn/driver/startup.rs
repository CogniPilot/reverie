use super::{WebPolicy, effects::Runtime, emit, exchange};
use crate::{
    hands_images,
    hands_prompt::{self, Build, ReserveRequest},
    journal_turn::{EffectReply, NativeEffect, Settings, Start, Turn},
    refused,
    worker_channel::WorkerChannel,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Job {
    prompt: Build,
    web: WebPolicy,
    memory: Option<Memory>,
    images: Option<Value>,
    workspace: Option<Workspace>,
    prompt_cap: usize,
    summary: bool,
    managed: bool,
    runtime: Runtime,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Workspace {
    tools: Vec<Value>,
    reserve_tools: Vec<Value>,
    rule: String,
    cancel_rule: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Memory {
    automatic: bool,
    max_chars: usize,
    native: Option<Settings>,
}

pub(super) struct Prepared {
    pub(super) messages: Vec<Value>,
    pub(super) web: WebPolicy,
    pub(super) journal: Journal,
    pub(super) workspace_tools: Option<Vec<Value>>,
    pub(super) prompt_cap: usize,
    pub(super) runtime: Runtime,
}

pub(super) struct Journal {
    pub(super) turn: Turn,
    native: Option<NativeEffect>,
}

impl Job {
    pub(super) fn prepare(mut self, channel: &mut WorkerChannel) -> io::Result<Prepared> {
        let journal = Journal::open(self.memory.take(), channel, &self.prompt)?;
        if let Some(merged) = &journal.turn.merged_recall {
            self.prompt.recalled.clone_from(merged);
        }
        let parts = self.images(channel)?;
        let mut messages = self.build(&journal, parts)?;
        let mut rule = journal.turn.context.clone();
        if let Some(workspace) = &self.workspace {
            rule.insert_str(0, &format!("\n{}", workspace.active_rule()));
        }
        let system = messages[0]["content"].as_str().ok_or_else(refused)?;
        messages[0]["content"] = json!(format!("{system}{rule}"));
        Ok(Prepared {
            messages,
            web: self.web,
            journal,
            workspace_tools: self.workspace.map(|workspace| workspace.tools),
            prompt_cap: self.prompt_cap,
            runtime: self.runtime,
        })
    }

    fn images(&mut self, channel: &mut WorkerChannel) -> io::Result<Vec<Value>> {
        let Some(settings) = self.images.take() else {
            return Ok(Vec::new());
        };
        let job = &self.prompt;
        let reply = hands_images::prepare(json!({
            "room":job.room, "message":job.message, "settings":settings
        }))
        .map_err(|_| io::Error::other("Hands image worker unavailable"))?;
        for (name, error) in reply.failures {
            emit(
                channel,
                &json!({"log":["image skipped",job.room,job.message["id"],name,error]}),
            )?;
        }
        self.prompt.notes = reply.notes;
        Ok(reply.parts)
    }

    fn build(&mut self, journal: &Journal, mut parts: Vec<Value>) -> io::Result<Vec<Value>> {
        let request: ReserveRequest = serde_json::from_value(json!({
            "cap":self.prompt_cap, "web": self.web,
            "journal": !journal.turn.context.is_empty(),
            "task":self.workspace.as_ref().map(|workspace| json!({"rule":workspace.rule,"tools":workspace.reserve_tools})),
            "summary":self.summary, "managed":self.managed,
        }))?;
        let reserve = request.calculate()?;
        self.prompt.now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_secs_f64();
        self.prompt.reserve = reserve_value(&reserve, "preferred")?;
        let (system, user) = match hands_prompt::build(&self.prompt) {
            Ok(prompt) => prompt,
            Err(_) => {
                self.prompt.reserve = reserve_value(&reserve, "required")?;
                hands_prompt::build(&self.prompt).map_err(io::Error::other)?
            }
        };
        let user = if parts.is_empty() {
            json!(user)
        } else {
            parts.insert(0, json!({"type":"text","text":user}));
            json!(parts)
        };
        Ok(vec![
            json!({"role":"system","content":system}),
            json!({"role":"user","content":user}),
        ])
    }
}

impl Workspace {
    fn active_rule(&self) -> &str {
        if self
            .tools
            .iter()
            .any(|tool| tool["function"]["name"] == "run_workspace_task")
        {
            &self.rule
        } else {
            &self.cancel_rule
        }
    }
}

impl Journal {
    fn open(
        options: Option<Memory>,
        channel: &mut WorkerChannel,
        prompt: &Build,
    ) -> io::Result<Self> {
        let (Some(options), Some(room)) = (options, prompt.room.as_ref()) else {
            return Ok(Self {
                turn: Turn::default(),
                native: None,
            });
        };
        let startup: Start = serde_json::from_value(json!({
            "room":room, "history":prompt.history.iter().map(source).collect::<Vec<_>>(),
            "message":source(&prompt.message), "clock_ms":prompt.now * 1000.0, "automatic":options.automatic,
            "evidence":{"text":prompt.recalled,"max_chars":options.max_chars},
        }))?;
        // Existing capture and action planning stay in the same journal session.
        let native = options
            .native
            .map(|settings| NativeEffect::new(room.clone(), settings));
        let turn = Turn::start(startup, &mut |request| {
            Self::effect(channel, native.as_ref(), request)
        });
        Ok(Self { turn, native })
    }

    fn effect(
        channel: &mut WorkerChannel,
        native: Option<&NativeEffect>,
        request: Value,
    ) -> io::Result<EffectReply> {
        if let Some(native) = native {
            return Ok(native.call(request));
        }
        let result = exchange(channel, json!({"effect":"memory","request":request}), 12)?;
        Ok(serde_json::from_value(result)?)
    }

    pub(super) fn invoke(&mut self, channel: &mut WorkerChannel, call: &Value) -> Value {
        self.turn.invoke(call, &mut |request| {
            Self::effect(channel, self.native.as_ref(), request)
        })
    }

    pub(super) fn tools(&self) -> Vec<Value> {
        if self.turn.names().is_empty() {
            Vec::new()
        } else {
            self.turn.tools().to_vec()
        }
    }
}

fn source(value: &Value) -> Value {
    let Some(fields) = value.as_object() else {
        return Value::Null;
    };
    Value::Object(
        fields
            .iter()
            .filter(|(key, _)| ["id", "roomId", "at", "text", "from"].contains(&key.as_str()))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    )
}

fn reserve_value(reserve: &Value, key: &str) -> io::Result<usize> {
    reserve[key]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(refused)
}
