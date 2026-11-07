use super::*;
use crate::{budget::BytePool, outbox::ChargedData};
use std::num::NonZeroU32;
use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};

struct FlushGate {
    accepted: mpsc::UnboundedSender<usize>,
    release: tokio::sync::oneshot::Receiver<()>,
}
impl AsyncWrite for FlushGate {
    fn poll_write(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.accepted.send(bytes.len()).unwrap();
        Poll::Ready(Ok(bytes.len()))
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.release)
            .poll(cx)
            .map(|result| result.map_err(io::Error::other))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

#[test]
fn buffered_acceptance_does_not_receipt_or_release_the_payload_before_flush() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (accepted, mut notices) = mpsc::unbounded_channel();
        let (release, blocked) = tokio::sync::oneshot::channel();
        let writer = FlushGate {
            accepted,
            release: blocked,
        };
        let pool = BytePool::new(64).unwrap();
        let lease = pool.reserve(NonZeroU32::new(64).unwrap()).unwrap();
        let packet = ChargedData::new(vec![7; 64], lease).unwrap();
        let (input, pending) = mpsc::channel(1);
        let (events, mut output) = mpsc::channel(1);
        let task = tokio::spawn(write_loop(1, writer, pending, events));
        input.send(StreamPacket::Data(packet)).await.unwrap();
        assert_eq!(notices.recv().await.unwrap(), 64);
        assert!(matches!(
            output.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        assert_eq!(pool.issued(), 64);
        release.send(()).unwrap();
        let NetworkEvent::Written { bytes, result, .. } = output.recv().await.unwrap() else {
            panic!("flushed write");
        };
        assert_eq!(bytes, 64);
        result.unwrap();
        assert_eq!(pool.issued(), 0);
        drop(input);
        task.await.unwrap();
    });
}

#[test]
fn receipt_waits_for_actual_write_and_retains_the_packet_charge_until_completion() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (writer, mut reader) = tokio::io::duplex(8);
        let pool = BytePool::new(64).unwrap();
        let lease = pool.reserve(NonZeroU32::new(64).unwrap()).unwrap();
        let packet = ChargedData::new(vec![7; 64], lease).unwrap();
        let (input, pending) = mpsc::channel(1);
        let (events, mut output) = mpsc::channel(1);
        let task = tokio::spawn(write_loop(1, writer, pending, events));
        input.send(StreamPacket::Data(packet)).await.unwrap();
        let mut first = [0; 8];
        reader.read_exact(&mut first).await.unwrap();
        assert_eq!(first, [7; 8]);
        assert!(matches!(
            output.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        assert_eq!(
            pool.issued(),
            64,
            "partial acceptance retains the entire allocation"
        );
        let mut rest = [0; 56];
        reader.read_exact(&mut rest).await.unwrap();
        let event = output.recv().await.unwrap();
        let NetworkEvent::Written {
            id,
            bytes,
            ended,
            result,
        } = event
        else {
            panic!("write completion");
        };
        assert_eq!((id, bytes, ended), (1, 64, false));
        result.unwrap();
        assert_eq!(pool.issued(), 0);
        input.send(StreamPacket::End).await.unwrap();
        let NetworkEvent::Written {
            bytes,
            ended,
            result,
            ..
        } = output.recv().await.unwrap()
        else {
            panic!("end completion");
        };
        assert_eq!((bytes, ended), (0, true));
        result.unwrap();
        task.await.unwrap();
    });
}
