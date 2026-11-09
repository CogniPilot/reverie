use crate::StoreError;
use reverie_contracts::chat_images::ImageDataError;
use std::fmt;

#[derive(Debug)]
pub enum ImageStoreError {
    Refused(&'static str),
    Store(StoreError),
    Close(StoreError),
    Unconfirmed(Box<Self>),
    Data(ImageDataError),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl ImageStoreError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Store(_) => "custody_unavailable",
            Self::Close(_) | Self::Unconfirmed(_) => "custody_unconfirmed",
            Self::Data(error) => error.code(),
            Self::Finalization { .. } => "custody_unconfirmed",
        }
    }
    pub fn is_uncertain(&self) -> bool {
        match self {
            Self::Close(_) | Self::Unconfirmed(_) => true,
            Self::Store(error) => error.has_unconfirmed_close(),
            Self::Finalization { primary, secondary } => {
                primary.is_uncertain() || secondary.is_uncertain()
            }
            _ => false,
        }
    }
}
impl fmt::Display for ImageStoreError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for ImageStoreError {}
impl From<StoreError> for ImageStoreError {
    fn from(error: StoreError) -> Self {
        if error.has_unconfirmed_close() {
            Self::Close(error)
        } else {
            Self::Store(error)
        }
    }
}
impl From<ImageDataError> for ImageStoreError {
    fn from(error: ImageDataError) -> Self {
        Self::Data(error)
    }
}
pub type Result<T> = std::result::Result<T, ImageStoreError>;
pub(super) fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(ImageStoreError::Refused(code))
    }
}
pub(super) fn finalized<T>(result: Result<T>, closed: Result<()>) -> Result<T> {
    match (result, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(ImageStoreError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
