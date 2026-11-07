use super::*;
use crate::captured_client::test_hooks::Gate;
#[test]
fn same_consumed_input_survives_actual_record_contention_without_accepting_a_later_frame() {
    if crate::test_process::isolate_case("worker_laptop::tests::existing_viewer::transport::contention::same_consumed_input_survives_actual_record_contention_without_accepting_a_later_frame") {return;}
    let fixture=Fixture::employee("created-viewer-echo");
    let service=Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (mut client,connection,hold)=accepted(&fixture,&service,"opencode");
    let existing=retained(&fixture,&connection);
    let viewer=started(&fixture,&existing,&connection);
    let relay=connection.begin_viewer_relay(fixture.runtime(),&viewer).unwrap();
    let input=Arc::new(Gate::default());let busy=Arc::new(Gate::default());
    struct Release(Arc<Gate>);
    impl Drop for Release {fn drop(&mut self){self.0.released.store(true,Ordering::Release);}}
    let release=Release(input.clone());
    let (reason,output)=std::thread::scope(|scope| {
        let entered=input.clone();let observed=busy.clone();
        let worker=scope.spawn(|| {
            crate::worker_reports::terminal::test_hooks::input_contention(entered,observed);
            run(relay,&fixture)
        });
        send(&mut client,b'I',b"same-frame");
        wait(||input.entered.load(Ordering::Acquire));
        // REAL record mutex refusal after the actual frame was fully read.
        let locked=existing.reference.record.lock().unwrap();
        input.released.store(true,Ordering::Release);
        wait(||busy.entered.load(Ordering::Acquire));
        drop(locked);
        send(&mut client,b'I',b"Q");
        let mut output=Vec::new();
        loop {
            let (kind,bytes)=receive(&mut client);
            if kind==b'X' {assert_eq!(bytes,b"7");break;}
            assert_eq!(kind,b'O');output.extend(bytes);
        }
        (worker.join().unwrap(),output)
    });
    drop(release);
    // Finalize owned native resources BEFORE this decisive RED/GREEN assertion.
    cleanup_component(&fixture,&existing,connection,hold,&service);
    assert!(matches!(reason,ViewerRelayEnd::ViewerExited(7)));
    assert_eq!(output,b"same-frame","Busy must not discard an already consumed I payload");
}
