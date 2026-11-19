//! Connect the owned coding worker's requests to scoped tasks and model effects.
use super::{Config, Pending, Task, View, model, receipts, runner};
use crate::{refused, worker_channel::remaining};
use serde_json::Value;
use std::{io, time::Duration};

impl Task {
    pub(super) fn submit_model(
        &mut self,
        cfg: &Config,
        managed: &mut bool,
        sequence: u64,
        mut payload: Value,
    ) -> io::Result<()> {
        let given = budget(&payload)?;
        self.use_model(|slot, job| {
            let left = remaining(job.deadline).ok_or_else(refused)?.min(given);
            slot.submit(left, payload["request"].take(), |request| {
                model::prepare(job, cfg, managed, request)
            })
        })?;
        self.pending = Some(Pending::Model(sequence));
        Ok(())
    }

    pub(super) fn submit_tool(
        &mut self,
        cfg: &Config,
        sequence: u64,
        mut payload: Value,
    ) -> io::Result<()> {
        if self.authorize(cfg, true).is_some() {
            return self.reply(Some(sequence), false, Value::Null);
        }
        let cap = payload["cap"]
            .as_u64()
            .and_then(|cap| usize::try_from(cap).ok())
            .ok_or_else(refused)?;
        let allowance = self.limits.output_chars.min(cap.saturating_sub(1024) / 6);
        if allowance < 500 {
            return self.reply(Some(sequence), true, runner::failure("output_limit"));
        }
        let timeout = remaining(self.deadline)
            .ok_or_else(refused)?
            .min(budget(&payload)?);
        if timeout.as_secs() == 0 {
            return Err(io::ErrorKind::TimedOut.into());
        }
        let runner = runner::Runner::start(
            cfg,
            self,
            payload["request"].take(),
            timeout,
            cap,
            allowance,
        )?;
        self.pending = Some(Pending::Runner { sequence, runner });
        Ok(())
    }

    pub(super) fn collect_effect(&mut self, cfg: &Config, view: &mut View) -> io::Result<bool> {
        let Some(mut pending) = self.pending.take() else {
            return Ok(true);
        };
        let completed = match &mut pending {
            Pending::Model(sequence) => self.collect_model(*sequence)?,
            Pending::Runner { sequence, runner } => {
                self.collect_runner(cfg, view, *sequence, runner)?
            }
        };
        if !completed {
            self.pending = Some(pending);
        }
        Ok(completed)
    }

    fn collect_model(&mut self, sequence: u64) -> io::Result<bool> {
        let answer = self.model.as_mut().ok_or_else(refused)?.poll()?;
        if let Some(mut answer) = answer {
            self.reply(
                Some(sequence),
                answer["ok"] == true,
                answer["result"].take(),
            )?;
            return Ok(true);
        }
        Ok(false)
    }

    fn collect_runner(
        &mut self,
        cfg: &Config,
        view: &mut View,
        sequence: u64,
        runner: &mut runner::Runner,
    ) -> io::Result<bool> {
        let Some(mut reply) = runner.poll(&self.limits)? else {
            return Ok(false);
        };
        let result = reply["result"].take();
        let report = reply.get("report").filter(|value| value.is_object());
        receipts::update(&cfg.state, &self.claim, |row| {
            receipts::tool(row, &runner.request, &result, report)
        })?;
        if let Some(report) = report {
            view.log(&format!("coding runner {} {report}", self.id));
        } else {
            view.log(&format!("coding runner {} report_unavailable", self.id));
        }
        let tool = runner.request["name"].as_str().unwrap_or("unknown");
        view.log(&format!(
            "coding result {} {tool} {}",
            self.id, result["ok"]
        ));
        self.reply(Some(sequence), true, result)?;
        Ok(true)
    }
}

fn budget(payload: &Value) -> io::Result<Duration> {
    payload["timeout"]
        .as_f64()
        .and_then(|seconds| Duration::try_from_secs_f64(seconds).ok())
        .filter(|timeout| !timeout.is_zero())
        .ok_or_else(refused)
}
