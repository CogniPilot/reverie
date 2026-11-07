use super::*;
fn bytes(value: &serde_json::Value) -> Vec<u8> {
    value
        .as_str()
        .unwrap()
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}
#[test]
fn original_python_accepted_socket_transcripts_match_full_wire() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!("legacy.json")).unwrap();
    for case in corpus["cases"].as_array().unwrap() {
        let fixture = Fixture::new();
        let mut service = WorkerReportService::from_runtime(&fixture.runtime);
        let name = case["name"].as_str().unwrap();
        if name == "peer-first" {
            service.uid ^= 1;
        }
        if name == "stopping" {
            fixture.runtime.request_stop();
        }
        let _busy = (name == "busy").then(|| fixture.collector.hold_report_for_owned_test());
        let (mut client, server) = fixture.sockets();
        std::thread::scope(|scope| {
            let task = scope.spawn(|| service.handle(server, &fixture.collector));
            client.write_all(&bytes(&case["requestHex"])).unwrap();
            if name == "truncated" {
                client.shutdown(std::net::Shutdown::Write).unwrap();
            }
            let mut wire = Vec::new();
            client.read_to_end(&mut wire).unwrap();
            let observed = task.join().unwrap();
            assert_eq!(
                wire,
                bytes(&case["responseHex"]),
                "actual original accepted socket: {name}; result {observed:?}"
            );
        });
        service.close(end()).unwrap();
    }
}
