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
    pub(in crate::worker_laptop) fn released_for_connection(
        &self,
        connection: &WorkerLaunchConnection,
    ) -> (LaptopWorkflow, CreatedLaptop, NixReleasedPane) {
        let (nix, plan, _request, phone) = self.resources();
        let runtime = self.runtime();
        let workflow = runtime
            .retain_laptop_network_for_connection(&nix, plan, phone, connection)
            .unwrap_or_else(|error| panic!("{}", error.cause()));
        assert_eq!(
            runtime.run_laptop_network(&workflow, end()).unwrap(),
            LaptopNetworkProgress::Ready
        );
        let telemetry = CommandTelemetry::capture(runtime, &self.source).unwrap();
        let LaptopCreation::Created(created) =
            runtime.create_laptop(&workflow, &telemetry, end()).unwrap()
        else {
            panic!("actual create")
        };
        runtime.publish_laptop_launch(&created).unwrap();
        let ContainerStart::Started(started) =
            runtime.start_laptop_container(&created, end()).unwrap()
        else {
            panic!("actual start")
        };
        let MemoryConfiguration::Configured(memory) = runtime
            .configure_started_laptop_memory(&started, end())
            .unwrap()
        else {
            panic!("actual absent memory")
        };
        let ColdCommit::Committed(cold) =
            runtime.commit_started_laptop_cold(&memory, end()).unwrap()
        else {
            panic!("actual cold")
        };
        let PaneStart::Started(pane) = runtime.start_laptop_pane(&cold, end()).unwrap() else {
            panic!("actual pane")
        };
        let NixGuardRelease::Released(released) =
            runtime.release_laptop_nix_guard(&pane, end()).unwrap()
        else {
            panic!("actual guard close")
        };
        (workflow, created, released)
    }
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
