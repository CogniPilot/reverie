use super::*;

/// Counts how many bytes a reader actually pulled.
struct Counting<'a> {
    bytes: &'a [u8],
    read: usize,
}
impl Read for Counting<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = buffer.len().min(self.bytes.len() - self.read);
        buffer[..count].copy_from_slice(&self.bytes[self.read..self.read + count]);
        self.read += count;
        Ok(count)
    }
}

#[test]
fn kind_lengths_are_the_spec_table() {
    let table: Vec<_> = KINDS.into_iter().map(Kind::lengths).collect();
    assert_eq!(
        table,
        [
            (20, 65619),
            (20, 8388628),
            (19, 82),
            (18, 18),
            (21, 22),
            (20, 65555),
            (21, 8388629)
        ]
    );
    assert_eq!(Direction::ToHandler.max_length(), 65619);
    // The typed response's media byte is the only growth.
    assert_eq!(Direction::ToFront.max_length(), 8388629);
}

#[test]
fn an_oversize_frame_is_refused_before_its_payload_is_read() {
    let mut wire = (Direction::ToHandler.max_length() as u32 + 1)
        .to_be_bytes()
        .to_vec();
    wire.resize(wire.len() + 64, 0);
    let mut reader = Counting {
        bytes: &wire,
        read: 0,
    };
    assert_eq!(
        read_frame(&mut reader, Direction::ToHandler),
        Err(FrameError::Length)
    );
    assert_eq!(reader.read, 4);

    let mut cancel = (HEADER_BYTES as u32 + 1).to_be_bytes().to_vec();
    cancel.extend_from_slice(&[VERSION, Kind::Cancel.byte()]);
    cancel.resize(cancel.len() + 64, 0);
    let mut reader = Counting {
        bytes: &cancel,
        read: 0,
    };
    assert_eq!(
        read_frame(&mut reader, Direction::ToHandler),
        Err(FrameError::Length)
    );
    assert_eq!(reader.read, 6);
}

#[test]
fn end_of_input_between_frames_is_clean_and_inside_one_is_truncated() {
    assert_eq!(read_frame(&mut [].as_slice(), Direction::ToFront), Ok(None));
    assert_eq!(
        read_frame(&mut [0u8].as_slice(), Direction::ToFront),
        Err(FrameError::Truncated)
    );
}

#[test]
fn every_kind_round_trips_through_its_reader() {
    let frames = [
        Body::Request {
            route: ROUTES[0].key.to_string(),
            json: b"{}".to_vec(),
        },
        Body::Response {
            status: 200,
            body: b"{}".to_vec(),
        },
        Body::Refusal {
            code: "REQUEST_SCHEMA".to_string(),
        },
        Body::Cancel,
        Body::Observe {
            observation: Observation::SubscriptionModes,
            providers: vec![Provider::Openai, Provider::Anthropic],
        },
        Body::Observed {
            observation: Observation::SubscriptionModes,
            json: b"{}".to_vec(),
        },
        Body::TypedResponse {
            media: Media::TextPlainUtf8,
            status: 200,
            body: b"hello".to_vec(),
        },
    ];
    for body in frames {
        let frame = Frame {
            generation: 3,
            id: 4,
            body,
        };
        let wire = frame.encode().expect("encodes");
        let direction = frame.body.kind().direction();
        let mut reader = wire.as_slice();
        assert_eq!(read_frame(&mut reader, direction), Ok(Some(frame)));
        assert!(reader.is_empty());
    }
}

#[test]
fn encode_refuses_what_a_reader_refuses() {
    let frame = Frame {
        generation: 1,
        id: 1,
        body: Body::Refusal {
            code: "lower".to_string(),
        },
    };
    assert_eq!(frame.encode(), Err(FrameError::Payload));
    let frame = Frame {
        generation: 0,
        id: 1,
        body: Body::Cancel,
    };
    assert_eq!(frame.encode(), Err(FrameError::Identity));
}

#[test]
fn a_typed_response_names_one_of_the_finite_media() {
    for byte in [0u8, 3, 255] {
        let mut wire = (HEADER_BYTES as u32 + 3).to_be_bytes().to_vec();
        wire.extend_from_slice(&[VERSION, Kind::TypedResponse.byte()]);
        wire.extend_from_slice(&1u64.to_be_bytes());
        wire.extend_from_slice(&1u64.to_be_bytes());
        wire.extend_from_slice(&[byte, 0, 200]);
        assert_eq!(
            read_frame(&mut wire.as_slice(), Direction::ToFront),
            Err(FrameError::Payload),
            "media {byte}"
        );
    }
    for media in MEDIA {
        assert_eq!(Media::from_byte(media.byte()), Some(media));
    }
    assert_eq!(
        Media::ApplicationJsonUtf8.content_type(),
        profiles::CONTENT_TYPE
    );
}
