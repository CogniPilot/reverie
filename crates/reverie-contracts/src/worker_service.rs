//! Fixed native service recipe DATA, shared by the package producer and upgrade
//! verifier. A matching string supplies no host or service authority.
pub fn native_unit(executable: &str) -> String {
    format!(
        "[Unit]\nDescription=Reverie native worker broker\n[Service]\nEnvironmentFile=%h/reverie/worker-pool/service/environment\nExecStart={executable} broker --config ${{REVERIE_WORKER_CONFIG}}\nRestart=no\nTimeoutStopSec=35\nKillMode=mixed\nUMask=0077\nNoNewPrivileges=true\nMemoryMax=512M\nTasksMax=512\n[Install]\nWantedBy=default.target\n"
    )
}
