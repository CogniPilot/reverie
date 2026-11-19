use super::Result;
use http::Uri;
use reverie_store::memory::MemoryStore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    env,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Deserialize)]
pub(super) struct Request {
    research_cycle_id: Option<String>,
    runtime: Option<Runtime>,
}

#[derive(Deserialize, Serialize)]
struct Runtime {
    url: String,
    session_id: String,
    #[serde(flatten)]
    metadata: serde_json::Map<String, Value>,
}

impl Request {
    pub(super) fn is_research(&self) -> bool {
        self.research_cycle_id
            .as_ref()
            .is_some_and(|id| !id.is_empty())
            || env::var_os("REVERIE_RESEARCH_CYCLE_ID").is_some_and(|id| !id.is_empty())
    }

    pub(super) fn validate(&self) -> Result<()> {
        if let Some(runtime) = &self.runtime {
            runtime.validate()?;
        }
        Ok(())
    }

    pub(super) fn record(&self, store: &MemoryStore) -> Result<Value> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64();
        let runtime = self
            .runtime
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        store.atomic(|tx| {
            tx.set_state("reverie_last_activity", &now.to_string())?;
            if let Some(runtime) = &runtime {
                tx.set_state("reverie_runtime", runtime)?;
            }
            Ok(())
        })?;
        Ok(json!({ "ok": true }))
    }
}

impl Runtime {
    fn validate(&self) -> Result<()> {
        let uri = self.url.parse::<Uri>()?;
        let local_host = uri.host().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost") || matches!(host, "127.0.0.1" | "[::1]" | "::1")
        });
        if uri.scheme_str() != Some("http") || !local_host {
            return Err("OpenCode runtime must use a local HTTP endpoint".into());
        }
        if self.session_id.is_empty() || uri.authority().is_some_and(|a| a.as_str().contains('@')) {
            return Err("invalid OpenCode runtime".into());
        }
        Ok(())
    }
}
