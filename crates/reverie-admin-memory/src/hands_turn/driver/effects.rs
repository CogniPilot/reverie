use super::{emit, exchange, web::Argument};
use crate::{
    hands_chat, hands_model,
    hands_prompt::{PendingSummary, estimate},
    hands_web::{self, Request as WebRequest},
    managed_context::{self, ContextStage},
    refused,
    worker_channel::WorkerChannel,
};
use serde::Deserialize;
use serde_json::{Map, Value, json, value::to_raw_value};
use std::{io, path::PathBuf};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Runtime {
    cli: Value,
    cli_timeout_s: f64,
    provided_summary: bool,
    managed: Option<Managed>,
    model: Option<Map<String, Value>>,
    room: Option<String>,
    message_id: Value,
    web_log: Option<PathBuf>,
    web_settings: Map<String, Value>,
    external_search: bool,
    external_fetch: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Managed {
    state_file: PathBuf,
    session: String,
    started: bool,
}

pub(super) struct Prompt {
    messages: Vec<Value>,
    pub(super) characters: usize,
    pending: Value,
}

impl Runtime {
    pub(super) fn prepare(
        &mut self,
        channel: &mut WorkerChannel,
        messages: &[Value],
        tools: Option<&[Value]>,
        cap: usize,
    ) -> io::Result<Prompt> {
        let summary = self.summary(channel)?;
        let schema = tools.map(to_raw_value).transpose()?;
        let (characters, pending) = estimate(
            messages,
            schema.as_deref(),
            Some(PendingSummary {
                text: summary,
                prompt_cap: cap,
            }),
        )?;
        let mut prompt = Prompt {
            messages: messages.to_vec(),
            characters,
            pending: Value::Null,
        };
        if let Some(snapshot) = pending {
            prompt
                .messages
                .insert(prompt.messages.len().min(2), snapshot);
        }
        if let Some(managed) = &mut self.managed {
            managed.insert(channel, &self.cli, &mut prompt, cap)?;
        }
        Ok(prompt)
    }

    fn summary(&self, channel: &mut WorkerChannel) -> io::Result<Option<String>> {
        if self.provided_summary {
            let value = exchange(channel, json!({"effect":"summary"}), 4)?;
            return Ok(value["text"].as_str().map(str::to_owned));
        }
        let summary = serde_json::from_value(self.cli.clone())
            .ok()
            .and_then(|cli| hands_chat::summary(cli, self.cli_timeout_s.min(2.0)));
        Ok(summary)
    }

    pub(super) fn ask(
        &self,
        channel: &mut WorkerChannel,
        prompt: Prompt,
        tools: Option<&[Value]>,
    ) -> io::Result<Value> {
        emit(
            channel,
            &json!({"observe":"model_start","data":{"chars": prompt.characters}}),
        )?;
        let mut output = if let Some(model) = &self.model {
            self.complete(channel, model.clone(), prompt, tools)?
        } else {
            exchange(
                channel,
                json!({"effect":"model","messages":prompt.messages,"tools":tools}),
                330,
            )?["output"]
                .clone()
        };
        if let Value::String(text) = output {
            output = json!({"content":text});
        }
        if !output.is_object() {
            return Err(io::Error::other("invalid model response"));
        }
        Ok(output)
    }

    fn complete(
        &self,
        channel: &mut WorkerChannel,
        model: Map<String, Value>,
        prompt: Prompt,
        tools: Option<&[Value]>,
    ) -> io::Result<Value> {
        if !prompt.pending.is_null() {
            let reported = managed_context::acknowledge(&self.cli, prompt.pending);
            emit(channel, &json!({"managed": {"reported":reported}}))?;
        }
        let mut job = Value::Object(model);
        if !job["payload"].is_object() {
            return Err(refused());
        }
        job["payload"]["messages"] = Value::Array(prompt.messages);
        if let Some(tools) = tools.filter(|tools| !tools.is_empty()) {
            job["payload"]["tools"] = json!(tools);
        }
        let mut response = hands_model::complete_chat(job).map_err(|_| refused())?;
        if response["ok"] == true {
            Ok(response["result"].take())
        } else if response["error"] == "model_timeout" {
            Err(io::Error::new(io::ErrorKind::TimedOut, "model deadline"))
        } else {
            Err(io::Error::other("model request failed"))
        }
    }

    pub(super) fn web(
        &self,
        channel: &mut WorkerChannel,
        argument: &Argument,
        invalid: &str,
    ) -> io::Result<String> {
        let (tool, value, external) = match argument {
            Argument::Fetch(url) => ("web_fetch", url, self.external_fetch),
            Argument::Search(query) => ("web_search", query, self.external_search),
            Argument::Invalid => return Ok(invalid.to_owned()),
        };
        if let Some(path) = &self.web_log
            && hands_web::execute(WebRequest::AppendDiagnostic {
                path: path.clone(),
                line: json!({
                    "at": jiff::Timestamp::now().strftime("%Y-%m-%dT%H:%M:%SZ").to_string(),
                    "room":self.room, "msg":self.message_id, "tool":tool, "query":value,
                })
                .to_string(),
            })
            .is_err()
        {
            emit(
                channel,
                &json!({"log":["web log failed, search not run",self.room,self.message_id]}),
            )?;
            return Ok("Search unavailable: the search log could not be written.".into());
        }
        let request = match argument {
            Argument::Fetch(url) => WebRequest::Fetch { url: url.clone() },
            Argument::Search(query) => WebRequest::Search {
                query: query.clone(),
                settings: self.web_settings.clone(),
            },
            Argument::Invalid => unreachable!("validated argument"),
        };
        let text = if external {
            exchange(channel, json!({"effect":tool,"argument":value}), 32)?
        } else {
            hands_web::execute(request).unwrap_or(Value::Null)
        };
        Ok(text["text"]
            .as_str()
            .unwrap_or(match argument {
                Argument::Fetch(_) => "Public web read unavailable.",
                _ => "Search failed: ValueError('Configured web search unavailable')",
            })
            .to_owned())
    }
}

impl Managed {
    fn insert(
        &mut self,
        channel: &mut WorkerChannel,
        cli: &Value,
        prompt: &mut Prompt,
        cap: usize,
    ) -> io::Result<()> {
        let stage = if self.started {
            ContextStage::ModelRequest
        } else {
            ContextStage::Startup
        };
        let available = cap.checked_sub(prompt.characters).ok_or_else(refused)?;
        let mut reply = managed_context::snapshot(
            cli,
            &std::path::absolute(&self.state_file)?,
            &self.session,
            stage,
            available,
        )
        .map_err(|_| io::Error::other("Managed context cannot fit the current prompt budget"))?;
        let used = reply["characters"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(refused)?;
        self.started = true;
        prompt.characters += used;
        prompt.messages.insert(1, reply["snapshot"].take());
        prompt.pending = reply["pending"].take();
        emit(
            channel,
            &json!({"managed":{"started":true,"pending":prompt.pending}}),
        )
    }
}
