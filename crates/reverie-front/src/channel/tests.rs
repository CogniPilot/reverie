use super::*;
use reverie_contracts::route_frames_v2::Body;
use std::io::{Read, Write};

#[test]
fn partial_frame_and_unacknowledged_reader_both_stop_on_owned_shutdown() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(qualify_shutdown());
}
async fn qualify_shutdown() {
    let (socket, mut peer) = UnixStream::pair().unwrap();
    let mut channel = Channel::start(socket).unwrap();
    let first = Frame {
        generation: 1,
        id: 0,
        body: Body::ServiceReady,
    }
    .encode(Direction::ToFront)
    .unwrap();
    peer.write_all(&first).unwrap();
    let incoming = channel.incoming.recv().await.unwrap();
    assert!(matches!(
        &incoming.frame,
        Ok(Some(Frame {
            body: Body::ServiceReady,
            ..
        }))
    ));
    // finish must join even when the reader is waiting for this receipt.
    channel.finish().await.unwrap();
    drop(incoming);
    assert_eq!(peer.read(&mut [0]).unwrap(), 0);
    let (socket, mut peer) = UnixStream::pair().unwrap();
    let channel = Channel::start(socket).unwrap();
    peer.write_all(&[0, 0]).unwrap();
    channel.finish().await.unwrap();
}

#[test]
fn reader_reports_the_contract_refusal_before_reading_an_oversized_payload() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(qualify_length());
}
async fn qualify_length() {
    let (socket, mut peer) = UnixStream::pair().unwrap();
    let mut channel = Channel::start(socket).unwrap();
    peer.write_all(&u32::MAX.to_be_bytes()).unwrap();
    let incoming = channel.incoming.recv().await.unwrap();
    assert_eq!(incoming.frame, Err(FrameError::Length));
    drop(incoming);
    channel.finish().await.unwrap();
}
