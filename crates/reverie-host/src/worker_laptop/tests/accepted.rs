//! One real peer/socket/frame constructor shared by native owning controls.
use super::*;
use crate::{
    command_telemetry::CommandTelemetry,
    worker_reports::{
        AcceptedWorkerConnection, WorkerLaunchConnection, WorkerLaunchHold, WorkerReportService,
    },
};
use std::{io::Write, os::unix::net::UnixStream};
impl Fixture {
    pub(in crate::worker_laptop) fn accepted(
        &self,
        service: &Arc<WorkerReportService>,
        command: &str,
    ) -> (UnixStream, WorkerLaunchConnection, WorkerLaunchHold) {
        let collector = CommandTelemetry::capture(self.runtime(), &self.source).unwrap();
        let (mut client, server) = UnixStream::pair().unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        client
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let raw = serde_json::to_vec(&json!({"sessionId":SID,"cwd":"/workspace","command":command,"env":{},"cols":80,"rows":24})).unwrap();
        let header =
            reverie_core::worker_wire::WorkerFrameHeader::for_payload(b'J', raw.len()).unwrap();
        client.write_all(&header.encode()).unwrap();
        client.write_all(&raw).unwrap();
        let AcceptedWorkerConnection::Launch(connection) =
            service.accept(server, &collector, &self.source).unwrap()
        else {
            panic!("actual J")
        };
        let hold = connection.retain_lifecycle().unwrap();
        (client, connection, hold)
    }
}
