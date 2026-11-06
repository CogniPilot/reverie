//! A Company's original lazy2-second fixed-server cache. Its real native jobs
//! and waiting request seats remain owned independently of async cancellation.
use super::{
    Company, OfficeError, Result,
    native_jobs::{NativeJob, NativeValue},
    request::RequestLifetime,
};
use reverie_contracts::worker_recovery::OfficeAddressData;
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex, RwLock},
    time::{Duration, Instant},
};
pub(super) struct Cache {
    value: Option<(OfficeAddressData, Instant)>,
    inflight: Option<Arc<NativeJob>>,
}
pub(super) enum AddressSource {
    Fixed(RwLock<SocketAddr>),
    Worker { name: String, cache: Mutex<Cache> },
}
impl AddressSource {
    pub(super) fn fixed(address: SocketAddr) -> Self {
        Self::Fixed(RwLock::new(address))
    }
    pub(super) fn worker(name: String) -> Self {
        Self::Worker {
            name,
            cache: Mutex::new(Cache {
                value: None,
                inflight: None,
            }),
        }
    }
    pub(super) fn update_fixed(&self, address: SocketAddr) -> Result<()> {
        let Self::Fixed(current) = self else {
            return Err(OfficeError::Refused);
        };
        *current.write().map_err(|_| OfficeError::Unconfirmed)? = address;
        Ok(())
    }
    pub(super) async fn targets(
        &self,
        company: &Company,
        lifetime: Arc<RequestLifetime>,
    ) -> Result<Vec<SocketAddr>> {
        match self {
            Self::Fixed(value) => Ok(vec![*value.read().map_err(|_| OfficeError::Unconfirmed)?]),
            Self::Worker { name, cache } => {
                let value = literal(company, name, cache, lifetime.clone()).await?;
                let job = company.native_jobs.socket(value, lifetime)?;
                match wait(&job).await? {
                    NativeValue::Socket(addresses) => Ok(addresses),
                    NativeValue::Address(..) => Err(OfficeError::Unconfirmed),
                }
            }
        }
    }
}
async fn literal(
    company: &Company,
    name: &str,
    cache: &Mutex<Cache>,
    lifetime: Arc<RequestLifetime>,
) -> Result<OfficeAddressData> {
    loop {
        let job = {
            let mut state = cache_lock(cache).await?;
            if let Some((value, _)) = state
                .value
                .as_ref()
                .filter(|(_, at)| at.elapsed() < Duration::from_secs(2))
            {
                return Ok(value.clone());
            }
            if let Some(job) = &state.inflight {
                job.retain_waiter(lifetime.clone())?;
                job.clone()
            } else {
                let job = company.native_jobs.backend(
                    company.engine.clone(),
                    name.to_owned(),
                    lifetime.clone(),
                )?;
                state.inflight = Some(job.clone());
                job
            }
        };
        let owner = job.is_owner(&lifetime)?;
        let outcome = wait(&job).await;
        let mut state = cache_lock(cache).await?;
        if state
            .inflight
            .as_ref()
            .is_some_and(|selected| Arc::ptr_eq(selected, &job))
        {
            state.inflight = None;
        }
        match outcome {
            Ok(NativeValue::Address(value, at)) => {
                state.value = Some((value.clone(), at));
                return Ok(value);
            }
            Ok(NativeValue::Socket(_)) => return Err(OfficeError::Unconfirmed),
            Err(error) if owner => return Err(error),
            // As with the original address_lock, another waiter gets its own
            // read after the first failed lookup, never a cached false success.
            Err(_) => (),
        }
    }
}
async fn cache_lock(cache: &Mutex<Cache>) -> Result<std::sync::MutexGuard<'_, Cache>> {
    loop {
        {
            match cache.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(std::sync::TryLockError::Poisoned(_)) => return Err(OfficeError::Unconfirmed),
                Err(std::sync::TryLockError::WouldBlock) => (),
            }
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}
async fn wait(job: &NativeJob) -> Result<NativeValue> {
    loop {
        if let Some(outcome) = job.poll()? {
            return outcome.map_err(OfficeError::Task);
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}
