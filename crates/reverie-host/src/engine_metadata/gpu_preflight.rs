//! The existing owner-local GPU preflight's four fixed metadata commands.
//! No setup, exec, device workload, lifecycle or engine mutation is exposed.
use super::{CancellationToken, EngineBootstrap, EngineError, Result};
use crate::captured_client::{CapturedClient, Policy};
use reverie_contracts::worker_image_switch::WorkerImageId;
use reverie_core::{ids::ProfileSessionId, worker_schema::WorkerBase};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    time::{Duration, Instant},
};

const IMAGE_FORMAT: &str = concat!(
    "{\"Id\":{{json .Id}},\"Config\":{\"User\":{{json .Config.User}},",
    "\"Labels\":{{json .Config.Labels}}}}"
);
const LAPTOP_FORMAT: &str = concat!(
    "{\"Id\":{{json .Id}},\"Image\":{{json .Image}},\"State\":{",
    "\"Running\":{{json .State.Running}},\"Pid\":{{json .State.Pid}},",
    "\"OOMKilled\":{{json .State.OOMKilled}},\"StartedAt\":{{json .State.StartedAt}}},",
    "\"Config\":{\"User\":{{json .Config.User}},\"Labels\":{{json .Config.Labels}}},",
    "\"HostConfig\":{{json .HostConfig}}}"
);

/// Same source invocation inputs, frozen at capture. The selected program is
/// supplied by installed code; no CLI or request may choose an executable.
#[must_use = "close the same captured engine before accepting a preflight result"]
pub struct GpuPreflightEngine {
    client: CapturedClient,
    endpoint_hint: Option<OsString>,
}
pub enum GpuPreflightQuery<'a> {
    Endpoint,
    Information,
    Image(&'a WorkerImageId),
    Laptop {
        base: &'a WorkerBase,
        session: &'a ProfileSessionId,
    },
}
impl GpuPreflightEngine {
    pub fn capture(program: &OsStr) -> Result<Self> {
        let environment: BTreeMap<_, _> = [
            "HOME",
            "PATH",
            "DOCKER_HOST",
            "DOCKER_CONTEXT",
            "XDG_CONFIG_HOME",
        ]
        .into_iter()
        .filter_map(|key| std::env::var_os(key).map(|value| (OsString::from(key), value)))
        .collect();
        let context = environment.get(OsStr::new("DOCKER_CONTEXT"));
        let endpoint_hint = environment
            .get(OsStr::new("DOCKER_HOST"))
            .filter(|value| !value.is_empty() && context.is_none_or(|value| value.is_empty()))
            .cloned();
        let bootstrap = EngineBootstrap::from_service(
            program,
            environment,
            std::env::current_dir().map_err(|_| EngineError::new(super::EngineFault::Bootstrap))?,
        )?;
        Ok(Self {
            client: CapturedClient::new(bootstrap.into_command()),
            endpoint_hint,
        })
    }
    pub fn endpoint_hint(&self) -> Option<&OsStr> {
        self.endpoint_hint.as_deref()
    }
    /// An eight-second window and one MiB of stdout, matching the original
    /// preflight rather than the broker's separate 20-second/four-MiB policy.
    pub fn query(&self, query: GpuPreflightQuery<'_>) -> Result<Vec<u8>> {
        let end = Instant::now() + Duration::from_secs(8);
        let output = self
            .client
            .run_gpu_preflight(
                query.arguments(),
                end,
                &CancellationToken::new(),
                Policy {
                    maximum: Duration::from_secs(8),
                    maximum_output: 1 << 20,
                    successful_exit: true,
                },
            )
            .map_err(|failure| EngineError::from(failure.error))?;
        Ok(output.stdout)
    }
    pub fn close(&self, end: Instant) -> Result<()> {
        self.client.close(end).map_err(Into::into)
    }
}
impl GpuPreflightQuery<'_> {
    fn arguments(self) -> Vec<OsString> {
        match self {
            Self::Endpoint => [
                "context",
                "inspect",
                "--format",
                "{{json .Endpoints.docker.Host}}",
            ]
            .map(Into::into)
            .to_vec(),
            Self::Information => ["info", "--format", super::GPU_INFORMATION_FORMAT]
                .map(Into::into)
                .to_vec(),
            Self::Image(image) => ["image", "inspect", "--format", IMAGE_FORMAT, image.as_str()]
                .map(Into::into)
                .to_vec(),
            Self::Laptop { base, session } => {
                let name = format!("{}-agent-{}", base.deployment(), session.as_str());
                ["container", "inspect", "--format", LAPTOP_FORMAT, &name]
                    .map(Into::into)
                    .to_vec()
            }
        }
    }
}
