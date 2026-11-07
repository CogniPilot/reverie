use super::*;
use reverie_host::worker_reports::{AcceptedWorkerServiceConnection, WorkerServiceConnection};
pub(super) fn connection(
    broker: &InstallingBroker,
    value: &Json,
) -> (UnixStream, WorkerServiceConnection) {
    let (mut client, server) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(45)))
        .unwrap();
    let bytes = serde_json::to_vec(value).unwrap();
    client.write_all(b"M").unwrap();
    client
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .unwrap();
    client.write_all(&bytes).unwrap();
    let snapshot = broker.configuration().unwrap();
    let AcceptedWorkerServiceConnection::Service(connection) = broker
        .reports
        .register_worker_connection(server)
        .unwrap()
        .receive_service_for_worker(&broker.telemetry, snapshot.configuration())
        .unwrap()
    else {
        panic!("actual kernel-authenticated M record");
    };
    assert_eq!(connection.peer().pid(), std::process::id() as i32);
    (client, connection)
}
pub(super) fn call(
    broker: &InstallingBroker,
    value: &Json,
) -> (
    u8,
    Json,
    std::result::Result<ChatImageHandlerClosed, Box<ChatImageHandlerFailure>>,
) {
    let (mut client, connection) = connection(broker, value);
    let result = broker.handle_chat_images(connection);
    let (kind, value) = reply(&mut client);
    (kind, value, result)
}
pub(super) fn reply(client: &mut UnixStream) -> (u8, Json) {
    let mut head = [0; 5];
    client.read_exact(&mut head).unwrap();
    let count = u32::from_be_bytes(head[1..].try_into().unwrap()) as usize;
    assert!(count <= 8192);
    let mut bytes = vec![0; count];
    client.read_exact(&mut bytes).unwrap();
    let value = if head[0] == b'J' {
        serde_json::from_slice(&bytes).unwrap()
    } else {
        json!({"error":String::from_utf8(bytes).unwrap()})
    };
    (head[0], value)
}
