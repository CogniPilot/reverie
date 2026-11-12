//! Fixed native service recipe DATA, shared by the package producer and upgrade
//! verifier. A matching string supplies no host or service authority.
pub fn native_unit(executable: &str) -> String {
    native_unit_for_role(executable, NativeWorkerServiceRole::Broker)
}
/// Closed OS installation choice, never a caller-selected command or argv.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeWorkerServiceRole {
    Broker,
    PoolOfferV1,
}
impl NativeWorkerServiceRole {
    pub fn unit_relative_path(self) -> &'static str {
        match self {
            Self::Broker => "share/systemd/user/reverie-worker-broker.service",
            Self::PoolOfferV1 => "share/systemd/pool-offer/reverie-worker-broker.service",
        }
    }
    fn command(self) -> &'static str {
        match self {
            Self::Broker => "broker",
            Self::PoolOfferV1 => "offer-pool-v1",
        }
    }
}
pub fn native_unit_for_role(executable: &str, role: NativeWorkerServiceRole) -> String {
    let command = role.command();
    format!(
        "[Unit]\nDescription=Reverie native worker broker\n[Service]\nEnvironmentFile=%h/reverie/worker-pool/service/environment\nExecStart={executable} {command} --config ${{REVERIE_WORKER_CONFIG}}\nRestart=no\nTimeoutStopSec=35\nKillMode=mixed\nUMask=0077\nNoNewPrivileges=true\nMemoryMax=512M\nTasksMax=512\n[Install]\nWantedBy=default.target\n"
    )
}
