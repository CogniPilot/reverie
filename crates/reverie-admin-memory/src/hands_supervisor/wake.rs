use super::{
    config::Config,
    view::View,
    worker::{Kind, Worker},
};
use crate::{
    hands_attention::{Notice, Status},
    hands_settings::truthy,
    worker_channel::WorkerChannel,
};
use serde_json::json;
use std::{
    env, io,
    sync::{Arc, Mutex},
    thread::{self, JoinHandle},
};

pub(super) struct Wake {
    link: Option<(Worker, JoinHandle<()>)>,
    state: Arc<Mutex<Shared>>,
    status: &'static str,
}

#[derive(Default)]
struct Shared {
    status: Option<Status>,
    wake: bool,
}

impl Wake {
    pub(super) fn start(cfg: &Config, once: bool) -> Self {
        let enabled = truthy(&cfg.values["phone_wake"]);
        let mut wake = Self {
            link: None,
            state: Arc::new(Mutex::new(Shared::default())),
            status: if enabled { "connecting" } else { "disabled" },
        };
        if enabled && !once && wake.connect(cfg).is_err() {
            wake.state.lock().expect("phone state").status = Some(Status::Unavailable);
        }
        wake
    }

    fn connect(&mut self, cfg: &Config) -> io::Result<()> {
        let env = |name| env::var(name).ok();
        let options = json!({"endpoint":env("REVERIE_API_URL"),"worker":env("REVERIE_WORKER"),
            "parent_session":env("REVERIE_SESSION_ID"),"session":cfg.values["self_session_id"]});
        let worker = Worker::start(Kind::Attention, &options)?;
        let input = worker.copy_receiver()?;
        let state = Arc::clone(&self.state);
        let listener = thread::Builder::new()
            .name("hands-phone-wake".into())
            .spawn(move || listen(input, &state))?;
        self.link = Some((worker, listener));
        Ok(())
    }

    pub(super) fn status(&self) -> &'static str {
        self.status
    }

    pub(super) fn clear(&self) {
        self.state.lock().expect("phone state").wake = false;
    }

    pub(super) fn pending(&self) -> bool {
        self.state.lock().expect("phone state").wake
    }

    pub(super) fn show(&mut self, view: &mut View) {
        let status = self.state.lock().expect("phone state").status;
        let Some(status) = status else {
            return;
        };
        let next = match status {
            Status::Active => "active",
            Status::Unscoped => "unavailable (no scoped laptop phone)",
            Status::OfficeDisabled => {
                "disabled by office configuration (all automatic room replies blocked)"
            }
            Status::Unavailable => "unavailable; polling fallback",
        };
        if self.status == next {
            return;
        }
        self.status = next;
        let detail = if status == Status::OfficeDisabled {
            ". Manual reads and terminal prompts remain available."
        } else {
            "; general messages use the normal scan."
        };
        view.observe(
            "note",
            json!({"text":format!("Phone wake: {next}{detail}")}),
        );
    }
}

fn listen(mut input: WorkerChannel, state: &Mutex<Shared>) {
    while let Ok(Some(notice)) = input.read::<Notice>(None) {
        let mut shared = state.lock().expect("phone state");
        shared.status = Some(notice.status);
        shared.wake |= notice.wake;
        if notice.status == Status::Unscoped {
            return;
        }
    }
    state.lock().expect("phone state").status = Some(Status::Unavailable);
}

impl Drop for Wake {
    fn drop(&mut self) {
        if let Some((worker, listener)) = self.link.take() {
            drop(worker);
            let _ = listener.join();
        }
    }
}
