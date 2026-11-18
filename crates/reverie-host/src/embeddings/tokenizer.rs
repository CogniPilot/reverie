//! Bounded tokenizer HTTP requests share the llama client transport.
use super::{
    LlamaError,
    http::TokenizerExchange,
    policy::{Origin, ProxySettings},
};
use http::HeaderValue;
use std::{error::Error, io, time::Duration};

pub enum Route {
    Properties,
    ApplyTemplate,
    Tokenize,
}

impl Route {
    const fn path(&self) -> &'static str {
        match self {
            Self::Properties => "/props",
            Self::ApplyTemplate => "/apply-template",
            Self::Tokenize => "/tokenize",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    Timeout,
    Http(u16),
    Invalid,
}

impl From<LlamaError> for Failure {
    fn from(error: LlamaError) -> Self {
        if let LlamaError::HttpStatus(status) = error {
            return Self::Http(status);
        }
        let mut source: Option<&(dyn Error + 'static)> = Some(&error);
        while let Some(error) = source {
            if error.is::<tokio::time::error::Elapsed>()
                || error
                    .downcast_ref::<io::Error>()
                    .is_some_and(|error| error.kind() == io::ErrorKind::TimedOut)
            {
                return Self::Timeout;
            }
            source = error.source();
        }
        Self::Invalid
    }
}

pub struct Client {
    base: String,
    timeout: Duration,
    limit: usize,
    proxies: ProxySettings,
}

impl Client {
    pub fn new(base: String, timeout: Duration, limit: usize) -> Result<Self, Failure> {
        if base.contains(['?', '#']) || timeout.is_zero() || limit == 0 {
            return Err(Failure::Invalid);
        }
        let base = base.trim_end_matches('/').to_owned();
        Origin::parse(&base)?;
        Ok(Self {
            base,
            timeout,
            limit,
            proxies: ProxySettings::capture(),
        })
    }

    pub async fn request(
        &self,
        route: Route,
        data: Option<Vec<u8>>,
        key: Option<&str>,
    ) -> Result<Vec<u8>, Failure> {
        let target = Origin::parse(&format!("{}{}", self.base, route.path()))?;
        let authorization = key
            .map(|key| HeaderValue::from_str(&format!("Bearer {key}")))
            .transpose()
            .map_err(|_| Failure::Invalid)?;
        TokenizerExchange {
            target: &target,
            timeout: self.timeout,
            limit: self.limit,
            authorization: authorization.as_ref(),
            proxies: &self.proxies,
        }
        .request(data)
        .await
        .map_err(Failure::from)
    }
}

#[cfg(test)]
pub(super) fn local_fixture(base: String, limit: usize) -> Client {
    Client {
        base,
        timeout: Duration::from_secs(2),
        limit,
        proxies: ProxySettings::default(),
    }
}
