use crate::{
    hands_poll,
    hands_settings::{model_request, startup_reply, truthy},
    hands_turn::WebPolicy,
    refused,
};
use serde_json::{Map, Value, json, value::RawValue};
use std::{
    io,
    path::{Path, PathBuf},
    time::Duration,
};

pub(super) struct Config {
    pub(super) values: Value,
    pub(super) path: PathBuf,
    pub(super) state: PathBuf,
    pub(super) poll: Duration,
    pub(super) chat_wait: Duration,
    pub(super) answer_wait: Duration,
}

impl Config {
    pub(super) fn load(path: &Path) -> io::Result<Self> {
        let raw = hands_poll::load_state(path)?.value.ok_or_else(refused)?;
        let mut validated = startup_reply(serde_json::from_str(raw.get())?);
        if let Some(error) = validated["error"].as_str() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                error.to_owned(),
            ));
        }
        let values = validated["settings"].take();
        if values["memory_worker_name"] != "agent_memory_worker.py" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Hands configuration requires the legacy adapter",
            ));
        }
        let state = serde_json::from_value(values["state_file"].clone())?;
        let poll = seconds(&values["poll_s"], 0.0, 0.0)?;
        let chat_wait = seconds(&values["cli_timeout_s"], 5.0, 90.0)?;
        let answer_wait = seconds(&values["model_timeout_s"], 5.0, 288.0)?;
        Ok(Self {
            values,
            path: path.to_owned(),
            state,
            poll,
            chat_wait,
            answer_wait,
        })
    }

    pub(super) fn poll_job(&self, state: Box<RawValue>) -> impl serde::Serialize + '_ {
        #[derive(serde::Serialize)]
        struct Job<'a> {
            office: Value,
            settings: Value,
            memory: Value,
            state: Box<RawValue>,
            path: &'a Path,
        }
        let cfg = &self.values;
        let rooms = if cfg["rooms"] == "auto" {
            Value::Null
        } else {
            cfg["rooms"].clone()
        };
        let memory = if truthy(&cfg["memory_instance"]) {
            json!({"mode":"native","config":self.automatic(),"timeout_s":cfg["memory_timeout_s"],
                   "recall_chars":cfg["recall_cap_chars"]})
        } else {
            json!({"mode":"disabled"})
        };
        Job {
            office: json!({"cli":cfg["cli"],"timeout_s":cfg["cli_timeout_s"]}),
            settings: json!({"rooms":rooms,"dm_rooms":cfg["dm_rooms"],"name":cfg["self_name"],
                "session":cfg["self_session_id"],"max_rooms":cfg["max_rooms"],"history_n":cfg["history_n"],
                "max_answers":cfg["max_answers_per_tick"],"reply_chars":cfg["reply_cap_chars"],
                "message_chars":cfg["message_cap_chars"],"preview":true,
                "coding":!cfg["coding"].is_null(),"coordinator":!cfg["coding"].is_null()}),
            memory,
            state,
            path: &self.state,
        }
    }

    pub(super) fn turn_job(
        &self,
        turn: &Value,
        zone: Option<&str>,
        managed_started: bool,
    ) -> Value {
        let cfg = &self.values;
        let room = &turn["room"];
        let direct = turn["direct"] == true;
        let managed = truthy(&cfg["managed_context"]);
        let web = WebPolicy::from_settings(cfg.as_object().expect("validated Hands configuration"));
        json!({"prompt":self.prompt_job(turn, zone),"images":self.images_job(turn),"workspace":null,"web":web,
            "memory":self.journal(room,direct),"prompt_cap":cfg["prompt_cap_chars"],"summary":true,
            "managed":managed,"runtime":self.runtime(turn,managed,managed_started)})
    }

    pub(super) fn prompt_job(&self, turn: &Value, zone: Option<&str>) -> Value {
        let cfg = &self.values;
        let mut settings = project(
            cfg,
            &[
                "system_preamble",
                "timezone",
                "identity_file",
                "memory_file",
                "identity_cap_chars",
                "memory_cap_chars",
                "message_cap_chars",
                "prompt_cap_chars",
                "recall_cap_chars",
            ],
        );
        settings.insert("reported_zone".into(), json!(zone));
        json!({"settings":settings,"scope":{"session":cfg["self_session_id"],"name":cfg["self_name"],"direct":turn["direct"] == true},
            "room":turn["room"],"history":turn["history"],"message":turn["message"],"notes":[],
            "now":epoch(),"reserve":0,"recalled":turn["recalled"].as_str().unwrap_or_default()})
    }

    pub(super) fn images_job(&self, turn: &Value) -> Option<Value> {
        let cfg = &self.values;
        (!turn["room"].is_null() && truthy(&turn["message"]["attachments"])).then(||
            json!({"vision":truthy(&cfg["vision"]),"root":cfg["attachments_root"],"session":cfg["self_session_id"],
                "cli":cfg["cli"],"max_images":cfg["max_images"],"max_bytes":cfg["max_image_bytes"],"timeout":cfg["cli_timeout_s"]}))
    }

    fn runtime(&self, turn: &Value, managed: bool, started: bool) -> Value {
        let cfg = &self.values;
        let context = managed.then(
            || json!({"state_file":self.state,"session":cfg["self_session_id"],"started":started}),
        );
        json!({"cli":cfg["cli"],"cli_timeout_s":cfg["cli_timeout_s"],"provided_summary":false,
            "managed":context,"model":model_request(cfg),"room":turn["room"],"message_id":turn["message"]["id"],
            "web_log":cfg["web_log"],"web_settings":project(cfg,&["search_url","search_results","search_timeout_s","search_max_bytes"]),
            "external_search":false,"external_fetch":false})
    }

    fn journal(&self, room: &Value, direct: bool) -> Option<Value> {
        let cfg = &self.values;
        if room.is_null() || !truthy(&cfg["journal_enabled"]) || !truthy(&cfg["memory_instance"]) {
            return None;
        }
        let automatic = !cfg["journal_auto_recall_exclude_rooms"]
            .as_array()
            .is_some_and(|rooms| rooms.contains(room));
        Some(
            json!({"automatic":automatic,"max_chars":cfg["recall_cap_chars"],"native":{
            "config":self.automatic(),"status_timeout_s":cfg["journal_status_timeout_s"],
            "command_timeout_s":cfg["journal_command_timeout_s"],"suppress":direct}}),
        )
    }

    fn automatic(&self) -> Map<String, Value> {
        project(
            &self.values,
            &[
                "cli",
                "memory_instance",
                "memory_timeout_s",
                "recall_cap_chars",
                "history_n",
                "message_cap_chars",
                "self_session_id",
                "journal_enabled",
            ],
        )
    }
}

fn project(cfg: &Value, keys: &[&str]) -> Map<String, Value> {
    keys.iter()
        .map(|&key| (key.to_owned(), cfg[key].clone()))
        .collect()
}

fn seconds(value: &Value, extra: f64, minimum: f64) -> io::Result<Duration> {
    let value = value.as_f64().ok_or_else(refused)?;
    if !value.is_finite() || value <= 0.0 {
        return Err(refused());
    }
    Duration::try_from_secs_f64((value + extra).max(minimum)).map_err(io::Error::other)
}

pub(super) fn epoch() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
