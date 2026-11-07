//! Chat image values are DATA; none is a room, file or laptop permission.
use crate::{
    ids::{ChatImageFileId, ChatMessageId, ChatRoomId, ProfileSessionId},
    operations::JournalDigest,
};
use std::collections::BTreeSet;
pub const MAX_FILES: usize = 4;
pub const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_CACHE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_CACHE_FILES: usize = 32;
pub const LIFETIME_SECONDS: u64 = 1800;
pub const CACHE_NAME: &str = ".reverie-chat-images";
pub const PUBLIC_ROOT: &str = "/tmp/.reverie-chat-images";
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImageDigest(JournalDigest);
impl ImageDigest {
    pub fn parse(value: &str) -> Option<Self> {
        JournalDigest::parse(value).ok().map(Self)
    }
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Raster {
    Png,
    Jpeg,
    Gif,
    Webp,
}
impl Raster {
    pub fn detect(bytes: &[u8]) -> Option<Self> {
        if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            Some(Self::Png)
        } else if bytes.starts_with(b"\xff\xd8\xff") {
            Some(Self::Jpeg)
        } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            Some(Self::Gif)
        } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            Some(Self::Webp)
        } else {
            None
        }
    }
    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Gif => "gif",
            Self::Webp => "webp",
        }
    }
    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
        }
    }
    pub fn from_mime(value: &str) -> Option<Self> {
        [Self::Png, Self::Jpeg, Self::Gif, Self::Webp]
            .into_iter()
            .find(|kind| kind.mime() == value)
    }
}
#[derive(Clone, Debug)]
pub struct ImageScope {
    session: ProfileSessionId,
    room: ChatRoomId,
    message: ChatMessageId,
    generation: ImageDigest,
    files: Vec<ChatImageFileId>,
}
impl ImageScope {
    pub fn try_new(
        session: ProfileSessionId,
        room: ChatRoomId,
        message: ChatMessageId,
        generation: ImageDigest,
        files: Vec<ChatImageFileId>,
    ) -> Option<Self> {
        if files.is_empty()
            || files.len() > MAX_FILES
            || files.iter().collect::<BTreeSet<_>>().len() != files.len()
        {
            return None;
        }
        Some(Self {
            session,
            room,
            message,
            generation,
            files,
        })
    }
    pub fn session(&self) -> &ProfileSessionId {
        &self.session
    }
    pub fn room(&self) -> &ChatRoomId {
        &self.room
    }
    pub fn message(&self) -> &ChatMessageId {
        &self.message
    }
    pub fn generation(&self) -> &ImageDigest {
        &self.generation
    }
    pub fn files(&self) -> &[ChatImageFileId] {
        &self.files
    }
}
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct ImageFileName(String);
impl ImageFileName {
    pub fn parse(value: &str) -> Option<Self> {
        let (id, suffix) = value.rsplit_once('.')?;
        ProfileSessionId::parse(id).ok()?;
        if !["png", "jpg", "gif", "webp"].contains(&suffix) {
            return None;
        }
        Some(Self(value.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
