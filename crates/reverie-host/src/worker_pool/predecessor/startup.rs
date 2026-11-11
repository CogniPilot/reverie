//! Read-only same-boot anchor capture for a newly started registered broker.
//! No container is stopped, renamed, removed or created by this observer.
use super::*;

struct Observation {
    engine: engine::Engine,
    namespace: namespace::Namespace,
    immutable: ImmutableInputObserver,
    anchor: Option<anchor::Anchor>,
}

/// Keeps the original native observers when capture or checked close fails.
#[must_use = "retain the original observation failure and its native owners"]
pub struct RetainedPoolObservationFailure {
    _owner: Option<Box<Observation>>,
    cause: PoolError,
}
impl fmt::Debug for RetainedPoolObservationFailure {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_tuple("RetainedPoolObservationFailure")
            .field(&self.cause)
            .finish()
    }
}
impl fmt::Display for RetainedPoolObservationFailure {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.cause.fmt(out)
    }
}
impl std::error::Error for RetainedPoolObservationFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}

/// Capture DATA from the installed anchor and private original birth. The
/// existing controller name must already be vacant; retirement is a separate
/// supported maintenance operation, never an implicit startup side effect.
pub fn observe_retained_pool_anchor(
    runtime: &WorkerRuntime,
    source: &Path,
    configuration: &EffectiveWorkerConfig,
    end: Instant,
) -> std::result::Result<RetainedPoolAnchor, Box<RetainedPoolObservationFailure>> {
    let provider = selected_provider(configuration, end).map_err(|cause| {
        Box::new(RetainedPoolObservationFailure {
            _owner: None,
            cause,
        })
    })?;
    let mut owner = Observation {
        engine: engine::Engine::new(runtime, end),
        namespace: namespace::Namespace::default(),
        immutable: ImmutableInputObserver::default(),
        anchor: None,
    };
    let observed = owner.observe(source, provider.policy());
    let closed = owner.close();
    finalized(observed, closed).map_err(|cause| {
        Box::new(RetainedPoolObservationFailure {
            _owner: Some(Box::new(owner)),
            cause,
        })
    })
}

fn selected_provider(
    configuration: &EffectiveWorkerConfig,
    end: Instant,
) -> Result<WorkerPoolProvider> {
    need(Instant::now() < end, "WORKER_POOL_PREDECESSOR_DEADLINE")?;
    WorkerPoolProvider::from_config(configuration)
        .map_err(|_| PoolError::Refused("WORKER_POOL_PROVIDER_INVALID"))?
        .ok_or(PoolError::Refused("WORKER_POOL_PROVIDER_REQUIRED"))
}

fn original_digest(raw: &[u8]) -> Result<JournalDigest> {
    let value: serde_json::Value = serde_json::from_slice(raw)
        .map_err(|_| PoolError::Refused("WORKER_POOL_STARTUP_ANCHOR_INSPECTION"))?;
    value["Config"]["Labels"]["reverie.pool.birth-policy"]
        .as_str()
        .and_then(|label| JournalDigest::parse(label).ok())
        .ok_or(PoolError::Refused("WORKER_POOL_STARTUP_ANCHOR_BIRTH"))
}

impl Observation {
    fn observe(&mut self, source: &Path, policy: &WorkerPoolPolicy) -> Result<RetainedPoolAnchor> {
        let home = native::python_path(&native::home_directory(None)?)?;
        need(
            Path::new(&policy.instance_root) == home.join("reverie"),
            "WORKER_POOL_PREDECESSOR_INSTANCE_ROOT",
        )?;
        let info = self.engine.query(EngineQuery::WorkerPoolInformation)?;
        reverie_contracts::worker_pool::validate_engine_information(info.as_bytes(), policy)
            .map_err(|_| PoolError::Refused("WORKER_POOL_PREDECESSOR_ENGINE"))?;
        self.engine.assert_name_absent(&policy.controller_name())?;
        let id = self.engine.selected_id(&policy.anchor_name())?;
        let raw = self
            .engine
            .query(EngineQuery::WorkerPoolWebsiteInspect(&id))?;
        let digest = original_digest(raw.as_bytes())?;
        self.namespace.capture(policy, digest.as_str())?;
        let birth = self.namespace.birth().identity();
        bootstrap::assert_predecessor_source(birth, source)?;
        engine::assert_original_broker_inactive(birth.broker().pid(), birth.broker().start())?;
        let program = self
            .immutable
            .observe_broker_program(birth.program(), self.engine.deadline())
            .map_err(|error| PoolError::BootstrapFacts(Box::new(error)))?;
        need(
            program.identity() == birth.broker().executable_identity(),
            "WORKER_POOL_PREDECESSOR_BROKER_EXECUTABLE_CHANGED",
        )?;
        self.anchor = Some(anchor::Anchor::unopened(policy));
        let anchor = self
            .anchor
            .as_mut()
            .expect("retained original anchor owner");
        anchor.observe(&self.engine, policy, &digest, None)?;
        need(
            anchor.data().container_id() == id.as_str(),
            "WORKER_POOL_RETAINED_ANCHOR_CHANGED",
        )?;
        anchor.assert_current(&self.engine, policy)?;
        engine::assert_original_broker_inactive(birth.broker().pid(), birth.broker().start())?;
        self.namespace.assert_current(policy, digest.as_str())?;
        self.engine.assert_name_absent(&policy.controller_name())?;
        Ok(anchor.data().clone())
    }

    fn close(&mut self) -> Result<()> {
        let query = self.engine.settle();
        let immutable = self
            .immutable
            .assert_finalized()
            .map_err(|error| PoolError::BootstrapFacts(Box::new(error)));
        let anchor = self.anchor.as_mut().map_or(Ok(()), anchor::Anchor::close);
        finalized(
            query,
            finalized(anchor, finalized(self.namespace.close(), immutable)),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn missing_provider_and_expired_observation_refuse_before_native_observers() {
        let config = worker_config::decode(b"{}").unwrap();
        assert_eq!(
            selected_provider(&config, Instant::now() + Duration::from_secs(1))
                .err()
                .unwrap()
                .code(),
            "WORKER_POOL_PROVIDER_REQUIRED"
        );
        assert_eq!(
            selected_provider(&config, Instant::now())
                .err()
                .unwrap()
                .code(),
            "WORKER_POOL_PREDECESSOR_DEADLINE"
        );
    }

    #[test]
    fn original_birth_digest_is_not_inferred_from_an_unrelated_or_invalid_label() {
        for raw in [
            b"{}".as_slice(),
            br#"{"Config":{"Labels":{"reverie.pool.birth-policy":"invalid"}}}"#,
        ] {
            assert!(original_digest(raw).is_err());
        }
        let raw = serde_json::to_vec(&serde_json::json!({"Config":{"Labels":{
            "reverie.pool.birth-policy":"a".repeat(64)}}}))
        .unwrap();
        assert_eq!(original_digest(&raw).unwrap().as_str(), "a".repeat(64));
    }
}
