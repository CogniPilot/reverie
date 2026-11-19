//! Launch the native Hands room loop with its existing bounded workers.
mod coding;
mod config;
mod state;
mod trace;
mod view;
mod wake;
mod worker;

use crate::{capture::Signals, hands_prompt::preview, hands_settings::truthy, refused};
use clap::Parser;
use coding::{Coding, Offer};
use config::{Config, epoch};
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    io,
    path::{Path, PathBuf},
    process::ExitCode,
    thread,
    time::{Duration, Instant},
};
use trace::Trace;
use view::{View, display};
use wake::Wake;
use worker::{Kind, Worker};

#[derive(Parser)]
#[command(name = "reverie-hands")]
struct Arguments {
    config: PathBuf,
    #[arg(long)]
    once: bool,
    #[arg(long)]
    no_tui: bool,
    #[arg(long)]
    check_config: bool,
}

pub(super) fn entry(args: impl IntoIterator<Item = OsString>) -> ExitCode {
    let args = Arguments::parse_from(std::iter::once(OsString::from("reverie-hands")).chain(args));
    match start(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Reverie Admin Harness could not start: {error}");
            ExitCode::FAILURE
        }
    }
}

fn start(args: Arguments) -> io::Result<()> {
    let cfg = Config::load(&args.config)?;
    if args.check_config {
        println!("configuration ok; runtime endpoints and sandbox not exercised");
        return Ok(());
    }
    let _session = state::reserve(&cfg.state)?;
    state::recover(&cfg.state)?;
    let signals = Signals::install()?;
    let view = View::start(&cfg, !args.no_tui && !args.once);
    let wake = Wake::start(&cfg, args.once);
    let mut run = Supervisor {
        cfg,
        signals,
        view,
        wake,
        zone: None,
        managed_started: false,
        outage: None,
        history: Vec::new(),
        coding: Coding::default(),
    };
    run.startup_notice();
    let result = match run.run(args.once) {
        Err(error) if error.kind() == io::ErrorKind::Interrupted => {
            run.view.log("stopped by operator");
            Ok(())
        }
        result => result,
    };
    let stopped = run.coding.stop(&run.cfg, "terminal_exit");
    result.and(stopped)
}

struct Supervisor {
    cfg: Config,
    signals: Signals,
    view: View,
    wake: Wake,
    zone: Option<String>,
    managed_started: bool,
    outage: Option<Outage>,
    history: Vec<Value>,
    coding: Coding,
}

#[derive(serde::Serialize)]
struct RoomAnswer {
    #[serde(flatten)]
    reply: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    coding: Option<state::Ordered>,
}

impl Supervisor {
    fn run(&mut self, once: bool) -> io::Result<()> {
        loop {
            self.signals.check()?;
            self.wake.clear();
            self.wake.show(&mut self.view);
            if self.check_prompt()? {
                return Ok(());
            }
            self.view.observe("poll", json!({}));
            if let Some(rooms) = self.cfg.values["rooms"].as_array() {
                self.view.observe("rooms", json!({"count":rooms.len()}));
            }
            match self.poll() {
                Ok(()) => {
                    self.pump_coding();
                    self.view.observe("idle", json!({}));
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => return Err(error),
                Err(error) => self.view.log(&format!("tick failed {error}")),
            }
            if once {
                return Ok(());
            }
            self.wait()?;
        }
    }

    fn check_prompt(&mut self) -> io::Result<bool> {
        let Some(prompt) = self.view.take() else {
            return Ok(false);
        };
        match self.local(&prompt) {
            Err(error) if error.kind() != io::ErrorKind::Interrupted => {
                self.view.log(&format!("terminal prompt failed {error}"));
                Ok(false)
            }
            result => result,
        }
    }

    fn startup_notice(&mut self) {
        let cfg = &self.cfg.values;
        let rooms = cfg["rooms"]
            .as_array()
            .map_or_else(|| "auto".into(), |rooms| rooms.len().to_string());
        self.view.log(&format!(
            "start rooms {rooms} model {} prompt_cap_chars {} vision {} search {} general_scan_s {} phone_wake {}",
            display(&cfg["model"]),cfg["prompt_cap_chars"],truthy(&cfg["vision"]),
            truthy(&cfg["search"]),cfg["poll_s"],self.wake.status()
        ));
    }

    fn poll(&mut self) -> io::Result<()> {
        let state = state::load(&self.cfg.state)?;
        let mut poll = Worker::start(Kind::Poll, &self.cfg.poll_job(state))?;
        loop {
            let event = poll.receive(self.cfg.chat_wait, &self.signals)?;
            if event["posted"].is_u64() {
                return Ok(());
            }
            if let Some(error) = event["error"].as_str() {
                return Err(io::Error::other(error.to_owned()));
            }
            match event["effect"].as_str() {
                Some("answer") => poll.send(&self.room_answer(&event)?)?,
                Some("before_chat") => poll.send(&self.before_chat())?,
                Some(_) => return Err(refused()),
                None => self.poll_event(&event),
            }
        }
    }

    fn poll_event(&mut self, event: &Value) {
        self.wake.show(&mut self.view);
        if let Some(receipt) = event.get("coding_post") {
            self.coding.acknowledge(receipt);
        }
        if let Some(zone) = event["time_zone"].as_str() {
            self.zone = Some(zone.to_owned());
        }
        if let Some(status) = event.get("room_list") {
            self.room_list(status["error"].as_str());
        }
        self.view.event(event);
    }

    fn room_answer(&mut self, turn: &Value) -> io::Result<RoomAnswer> {
        let outcome = if turn["control"] == true {
            let directive = turn["message"]["text"].as_str().ok_or_else(refused)?;
            self.coding
                .control(&self.cfg, turn, directive, self.zone.as_deref())
                .map(|reply| json!({"reply":reply,"characters":0,"searches":0,"timing":"-"}))
        } else {
            self.answer(turn).map(|result| json!({
                "reply":result["answer"],"characters":result["characters"],"searches":result["searches"],
                "timing":result["timing"]
            }))
        };
        let reply = match outcome {
            Ok(reply) => reply,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => return Err(error),
            Err(error) => json!({"failure":error.to_string()}),
        };
        Ok(RoomAnswer {
            reply,
            coding: Coding::snapshot(&self.cfg)?,
        })
    }

    fn before_chat(&mut self) -> Value {
        match self.coding.before_chat() {
            Ok(()) => json!({}),
            Err(error) => json!({"failure":error.to_string()}),
        }
    }

    fn pump_coding(&mut self) {
        self.coding
            .pump(&self.cfg, &mut self.view, &mut self.managed_started);
    }

    fn answer(&mut self, turn: &Value) -> io::Result<Value> {
        let mut trace = Trace::new();
        let mut result = self.ask(turn, &mut trace);
        let path = self.cfg.values["turn_trace_file"].as_str().map(Path::new);
        if trace.finish(path, turn, &result).is_err() {
            self.view.log("turn trace not written");
        }
        if let Ok(result) = &mut result {
            result["timing"] = json!(trace.timings());
        }
        result
    }

    fn ask(&mut self, turn: &Value, trace: &mut Trace) -> io::Result<Value> {
        let offer = coding::offer(&self.cfg, turn);
        let mut job = self
            .cfg
            .turn_job(turn, self.zone.as_deref(), self.managed_started);
        if let Some(offer) = &offer {
            job["workspace"] = offer.options()?;
        }
        let mut answer = Worker::start(Kind::Answer, &job)?;
        loop {
            let event = answer.receive(self.cfg.answer_wait, &self.signals)?;
            if let Some(error) = event["error"].as_str() {
                return Err(answer_error(error, event["timeout"] == true));
            }
            if event["answer"].is_string() {
                return Ok(event);
            }
            if let Some(effect) = event["effect"].as_str() {
                let offer = offer
                    .as_ref()
                    .filter(|_| effect == "workspace")
                    .ok_or_else(refused)?;
                let reply = self.workspace(offer, turn, &event["call"])?;
                answer.send(&json!({"reply":reply}))?;
            }
            self.managed_started |= event["managed"]["started"] == true;
            self.wake.show(&mut self.view);
            trace.event(&event);
            self.view.event(&event);
        }
    }

    fn workspace(&mut self, offer: &Offer, turn: &Value, call: &Value) -> io::Result<String> {
        match offer.directive(&turn["message"], call)? {
            Ok(directive) => self
                .coding
                .control(&self.cfg, turn, &directive, self.zone.as_deref()),
            Err(reason) => Ok(reason),
        }
    }

    fn wait(&mut self) -> io::Result<()> {
        let until = Instant::now() + self.cfg.poll;
        while Instant::now() < until {
            self.signals.check()?;
            self.wake.show(&mut self.view);
            if self.wake.pending() || self.view.pending() {
                break;
            }
            self.pump_coding();
            thread::sleep(
                until
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(50)),
            );
        }
        Ok(())
    }

    fn room_list(&mut self, error: Option<&str>) {
        let Some(error) = error else {
            if let Some(outage) = self.outage.take() {
                self.view.log(&format!(
                    "room list recovered failures={} elapsed_s={}",
                    outage.failures,
                    outage.start.elapsed().as_secs()
                ));
            }
            return;
        };
        if let Some(outage) = &mut self.outage {
            outage.failures = outage.failures.saturating_add(1);
            if outage.last.elapsed() >= Duration::from_secs(60) {
                outage.last = Instant::now();
                self.view.log(&format!(
                    "room list still unavailable, reading no rooms failures={} elapsed_s={}",
                    outage.failures,
                    outage.start.elapsed().as_secs()
                ));
            }
        } else {
            let now = Instant::now();
            self.outage = Some(Outage {
                start: now,
                last: now,
                failures: 1,
            });
            self.view.log(&format!(
                "room list failed, reading no room this tick {error}"
            ));
        }
    }

    fn local(&mut self, prompt: &str) -> io::Result<bool> {
        match prompt {
            "/quit" => return Ok(true),
            "/status" => {
                let text = self.view.status(self.wake.status());
                self.view.observe("note",json!({"text":text}));
            }
            "/help" => self.view.observe("note",json!({"text":"Type a prompt to chat here. /status shows runtime observations; /clear clears this terminal conversation; /quit exits. Ctrl+C exits during a request. PgUp/PgDn scroll. Terminal prompts are not posted to rooms."})),
            "/clear" => {
                self.history.clear();
                self.view.clear();
                self.view.observe("note",json!({"text":"Terminal conversation cleared."}));
            }
            text if text.starts_with('/') => self.view.observe("note",json!({"text":"Unknown terminal command. Use /help."})),
            text => self.local_answer(text)?,
        }
        Ok(false)
    }

    fn local_answer(&mut self, text: &str) -> io::Result<()> {
        self.coding.before_chat()?;
        let stamp = epoch();
        let id = format!(
            "terminal-{}",
            std::time::Duration::try_from_secs_f64(stamp)
                .map_err(io::Error::other)?
                .as_nanos()
        );
        let message =
            json!({"id":id,"at":stamp*1000.0,"from":{"kind":"user","name":"You"},"text":text});
        let mut incoming = preview(
            &message,
            self.cfg.values["message_cap_chars"]
                .as_u64()
                .unwrap_or(4000) as usize,
        );
        incoming["room"] = json!("terminal");
        self.view.observe("incoming", incoming);
        let output = self.answer(&json!({"room":null,"message":message,"history":self.history}))?;
        let reply = output["answer"]
            .as_str()
            .filter(|text| !text.is_empty())
            .ok_or_else(refused)?;
        let sent = reply
            .chars()
            .take(self.cfg.values["reply_cap_chars"].as_u64().unwrap_or(6000) as usize)
            .collect::<String>();
        self.view
            .observe("local_reply", json!({"room":"terminal","text":sent}));
        self.history.push(message);
        self.history
            .push(json!({"id":format!("{id}-reply"),"at":epoch()*1000.0,
            "from":{"kind":"agent","name":self.cfg.values["self_name"]},"text":sent}));
        let keep = self.cfg.values["history_n"]
            .as_u64()
            .unwrap_or(30)
            .saturating_mul(2)
            .clamp(2, 200);
        self.history
            .drain(..self.history.len().saturating_sub(keep as usize));
        Ok(())
    }
}

struct Outage {
    start: Instant,
    last: Instant,
    failures: u64,
}

fn answer_error(error: &str, timeout: bool) -> io::Error {
    let kind = if timeout {
        io::ErrorKind::TimedOut
    } else {
        io::ErrorKind::Other
    };
    io::Error::new(kind, error.to_owned())
}
