//! Own the model transcript and run a complete bounded Hands reply.
mod diagnostic;
mod effects;
mod startup;

use super::{Decision, Phase, Plan, Planning, Settlement, Stage, WebPolicy, journal_replay, web};
use crate::{TURN_CAPTURE_BOUND, refused, worker_channel::WorkerChannel};
use serde_json::{Value, json};
use startup::{Job, Prepared};
use std::{
    io,
    time::{Duration, Instant},
};

struct Turn {
    job: Prepared,
    stage: Stage,
    searches: usize,
    largest: usize,
}

pub(crate) fn run_answer(parent: i32) -> io::Result<()> {
    crate::bind_worker(parent)?;
    let mut channel = WorkerChannel::open()?;
    let job: Job = channel
        .read_bounded(Some(deadline(5)), TURN_CAPTURE_BOUND)?
        .ok_or_else(refused)?;
    let result = reply(job, &mut channel);
    emit(&mut channel, &result)
}

fn reply(job: Job, channel: &mut WorkerChannel) -> Value {
    let outcome = job.prepare(channel).and_then(|job| {
        let mut turn = Turn { job, stage: Stage::Explore, searches: 0, largest: 0 };
        let reply = turn.answer(channel)?;
        Ok(json!({"answer":reply, "characters":turn.largest, "searches":turn.searches, "outcome":super::reply_outcome(&reply)}))
    });
    outcome.unwrap_or_else(|error| json!({"error":error.to_string(), "timeout":error.kind() == io::ErrorKind::TimedOut}))
}

impl Turn {
    fn plan(&mut self) -> Plan {
        let plan = Planning {
            stage: self.stage,
            web: self.job.web,
            searches: self.searches,
            journal_available: !self.job.journal.turn.tools().is_empty(),
            journal_tools: self.job.journal.tools(),
            task_tools: self.job.workspace_tools.clone(),
        }
        .choose();
        if let Some(note) = plan.note {
            if plan.replace_note {
                self.job.messages.pop();
            }
            self.job
                .messages
                .push(json!({"role":"user", "content":note}));
        }
        plan
    }

    fn ask(
        &mut self,
        plan: &Plan,
        channel: &mut WorkerChannel,
    ) -> io::Result<(Value, usize, Duration)> {
        let charge_tools = self.job.workspace_tools.is_some()
            || self.job.web.fetch
            || !self.job.journal.turn.tools().is_empty();
        let request = self.job.runtime.prepare(
            channel,
            &self.job.messages,
            plan.tools.as_deref().filter(|_| charge_tools),
            self.job.prompt_cap,
        )?;
        let characters = request.characters;
        if characters > self.job.prompt_cap {
            return Err(io::Error::other(format!(
                "request of {characters} chars is over prompt_cap_chars, not sent"
            )));
        }
        self.largest = self.largest.max(characters);
        let started = Instant::now();
        let output = self
            .job
            .runtime
            .ask(channel, request, plan.tools.as_deref())?;
        Ok((output, characters, started.elapsed()))
    }

    fn answer(&mut self, channel: &mut WorkerChannel) -> io::Result<String> {
        loop {
            let plan = self.plan();
            let (output, characters, elapsed) = self.ask(&plan, channel)?;
            let settlement = Settlement {
                phase: plan.phase,
                web: self.job.web,
                searches: self.searches,
                journal_names: self.job.journal.turn.names(),
                output,
            };
            let model = super::ModelStep::read(&settlement.output);
            diagnostic::model(
                channel,
                &settlement.output,
                plan.tools.as_ref().is_some_and(|tools| !tools.is_empty()),
                model.outcome(),
                characters,
                elapsed,
            )?;
            if let Some(reply) = self.workspace(channel, plan.phase, &settlement.output)? {
                return Ok(reply);
            }
            if let Some(reply) = self.apply(channel, settlement.decide(&model), plan.phase)? {
                return Ok(reply);
            }
        }
    }

    fn workspace(
        &self,
        channel: &mut WorkerChannel,
        phase: Phase,
        output: &Value,
    ) -> io::Result<Option<String>> {
        let calls = &output["tool_calls"];
        if !matches!(phase, Phase::Direct | Phase::Tools) || !crate::hands_settings::truthy(calls) {
            return Ok(None);
        }
        let call = crate::coding_task::workspace_call(calls, self.job.workspace_tools.is_some());
        if let Some(error) = call["error"].as_str() {
            return Ok(Some(error.to_owned()));
        }
        if !call["action"].is_string() {
            return Ok(None);
        }
        let reply = exchange(channel, json!({"effect":"workspace","call":call}), 10)?;
        Ok(reply["reply"].as_str().map(str::to_owned))
    }

    fn apply(
        &mut self,
        channel: &mut WorkerChannel,
        decision: Decision,
        phase: Phase,
    ) -> io::Result<Option<String>> {
        match decision {
            Decision::Done { reply, reason } => {
                diagnostic::finish(channel, phase, reason, self.searches)?;
                return Ok(Some(reply));
            }
            Decision::Finish => self.stage = Stage::Finish,
            Decision::Retry => self.stage = Stage::Retry,
            Decision::Journal { call } => self.journal(channel, &call)?,
            Decision::Web {
                call,
                argument,
                visible,
                searches,
                invalid_result,
            } => {
                let started = Instant::now();
                let text = self.job.runtime.web(channel, &argument, invalid_result)?;
                diagnostic::timing(channel, "search", started, Value::Null)?;
                self.searches = searches;
                self.job.messages.extend(web::web_replay(
                    &call,
                    &argument,
                    &visible,
                    &text,
                    self.job.web.result_chars,
                ));
            }
        }
        Ok(None)
    }

    fn journal(&mut self, channel: &mut WorkerChannel, call: &Value) -> io::Result<()> {
        let result = self.job.journal.invoke(channel, call);
        diagnostic::journal(channel, call, &result)?;
        self.job.messages.extend(journal_replay(
            call,
            self.job.journal.turn.replay.clone(),
            serde_json::to_string(&result)?,
        ));
        Ok(())
    }
}

fn emit(channel: &mut WorkerChannel, value: &Value) -> io::Result<()> {
    channel.write_bounded(value, Some(deadline(5)), TURN_CAPTURE_BOUND)
}

fn exchange(channel: &mut WorkerChannel, request: Value, seconds: u64) -> io::Result<Value> {
    emit(channel, &request)?;
    channel
        .read_bounded(Some(deadline(seconds)), TURN_CAPTURE_BOUND)?
        .ok_or_else(refused)
}

fn deadline(seconds: u64) -> Instant {
    Instant::now() + Duration::from_secs(seconds)
}
