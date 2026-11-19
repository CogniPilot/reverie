use super::{
    config::Config,
    worker::{Kind, Worker},
};
use crate::hands_settings::truthy;
use serde_json::{Value, json};
use std::{env, io, time::Duration};

pub(super) struct View {
    worker: Option<Worker>,
    interactive: bool,
}

impl View {
    pub(super) fn start(config: &Config, interactive: bool) -> Self {
        let settings = &config.values;
        let secrets = [settings["model_key_env"].as_str(), Some("REVERIE_PASSWORD")]
            .into_iter()
            .flatten()
            .filter_map(|name| env::var(name).ok())
            .filter(|secret| !secret.is_empty())
            .collect::<Vec<_>>();
        let cfg = json!({"interactive":interactive,"capture":false,
            "api_base":settings["api_base"],"model":settings["model"],"self_name":settings["self_name"],
            "poll_s":settings["poll_s"],"prompt_cap_chars":settings["prompt_cap_chars"],"reply_max_tokens":settings["reply_max_tokens"],
            "message_cap_chars":settings["message_cap_chars"],"coding":false,"search":truthy(&settings["search"]),
            "memory":truthy(&settings["memory_instance"]),"trace":settings["model_events_file"],"secrets":secrets});
        let mut view = Self {
            worker: Worker::start(Kind::Terminal, &cfg).ok(),
            interactive: false,
        };
        if view.receive().is_none() {
            println!("Terminal unavailable; the harness will continue.");
        }
        view
    }

    fn receive(&mut self) -> Option<Value> {
        let result: io::Result<Value> = self
            .worker
            .as_mut()?
            .receive_as(Duration::from_secs(2), &|| Ok(()));
        match result {
            Ok(reply) => {
                self.interactive = reply["interactive"] == true;
                Some(reply)
            }
            Err(_) => {
                self.worker.take();
                self.interactive = false;
                None
            }
        }
    }

    fn request(&mut self, request: Value) -> Option<Value> {
        if self.worker.as_mut()?.send(&request).is_err() {
            self.worker.take();
            self.interactive = false;
            return None;
        }
        self.receive()
    }

    pub(super) fn observe(&mut self, kind: &str, mut fields: Value) {
        fields["kind"] = json!(kind);
        self.request(json!({"action":"observe","event":fields}));
    }

    pub(super) fn event(&mut self, event: &Value) {
        if let Some(kind) = event["observe"].as_str() {
            self.observe(kind, event["data"].clone());
        }
        if let Some(parts) = event["log"].as_array() {
            let text = parts.iter().map(display).collect::<Vec<_>>().join(" ");
            self.log(&text);
        }
    }

    pub(super) fn log(&mut self, text: &str) {
        let kind = if text.contains("failed") || text.contains("unavailable") {
            "error"
        } else {
            "note"
        };
        self.observe(kind, json!({"text":text}));
    }

    pub(super) fn pending(&mut self) -> bool {
        self.interactive
            && self
                .request(json!({"action":"poll","take_input":false}))
                .is_some_and(|reply| reply["pending"] == true)
    }

    pub(super) fn take(&mut self) -> Option<String> {
        if !self.interactive {
            return None;
        }
        self.request(json!({"action":"poll","take_input":true}))?["prompt"]
            .as_str()
            .map(str::to_owned)
    }

    pub(super) fn status(&mut self, status: &str) -> String {
        self.request(json!({"action":"status","phone_wake":status}))
            .and_then(|reply| reply["summary"].as_str().map(str::to_owned))
            .unwrap_or_else(|| "Terminal unavailable.".into())
    }

    pub(super) fn clear(&mut self) {
        self.request(json!({"action":"clear"}));
    }
}

impl Drop for View {
    fn drop(&mut self) {
        self.request(json!({"action":"stop"}));
    }
}

pub(super) fn display(value: &Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), str::to_owned)
}
