//! Select installed-provider recovery before any fresh installation offer.
use reverie_application::{
    installing_broker::{BrokerServiceStartup, InstallingBroker},
    worker_validation::ValidatedWorkerSnapshot,
};
use reverie_contracts::{
    worker_config::EffectiveWorkerConfig, worker_pool::WorkerPoolProvider,
    worker_service::NativeWorkerServiceRole,
};
use reverie_host::{worker_pool::observe_retained_pool_anchor, worker_runtime::WorkerRuntime};
use std::time::{Duration, Instant};

#[derive(Debug, PartialEq, Eq)]
enum Selection {
    Retained,
    Offer,
    Ordinary,
}
fn selection(
    configuration: &EffectiveWorkerConfig,
    offer: bool,
) -> Result<Selection, std::io::Error> {
    let provider = WorkerPoolProvider::from_config(configuration)
        .map_err(|_| std::io::Error::other("WORKER_POOL_PROVIDER_INVALID"))?;
    Ok(if provider.is_some() {
        Selection::Retained
    } else if offer {
        Selection::Offer
    } else {
        Selection::Ordinary
    })
}

pub(super) fn prepare(
    snapshot: ValidatedWorkerSnapshot,
    runtime: WorkerRuntime,
    offer: bool,
) -> Result<BrokerServiceStartup, Box<dyn std::error::Error>> {
    let mode = selection(snapshot.configuration(), offer)?;
    let anchor = if mode == Selection::Retained {
        let source = snapshot
            .source_path()
            .ok_or("NATIVE_SERVICE_ORIGINAL_SOURCE_REQUIRED")?;
        Some(observe_retained_pool_anchor(
            &runtime,
            source,
            snapshot.configuration(),
            Instant::now() + Duration::from_secs(30),
        )?)
    } else {
        None
    };
    let broker = InstallingBroker::new(snapshot, runtime)?;
    if let Some(anchor) = anchor {
        let role = if offer {
            NativeWorkerServiceRole::PoolOfferV1
        } else {
            NativeWorkerServiceRole::Broker
        };
        return Ok(broker.prepare_service_with_retained_pool(anchor, role)?);
    }
    if mode == Selection::Offer {
        return Ok(broker
            .prepare_os_pool_installation_offer(Instant::now() + Duration::from_secs(300))?
            .prepare_service()?);
    }
    Ok(broker.prepare_service()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reverie_contracts::worker_config;

    #[test]
    fn configured_provider_never_replays_offer_and_invalid_provider_never_falls_back() {
        let raw = serde_json::json!({"workerPoolProvider":{
        "version":1,"purpose":"reverie-docker-worker-pool-provider-v1","policy":{
            "version":1,"purpose":"reverie-docker-worker-pool-v1","deployment":"synthetic",
            "instanceRoot":"/home/synthetic/reverie","engineId":"11111111-1111-4111-8111-111111111111",
            "anchorImage":format!("sha256:{}","a".repeat(64)),
            "controllerImage":format!("sha256:{}","b".repeat(64)),"websiteContainer":"c".repeat(64),
            "brokerUid":1000,"brokerGid":1000,"memoryMaxMiB":49152,"poolTasksMax":8192,
                "cpuWeight":100,"allowedCpus":[0],"employeeMemoryHighMiB":{"22222222-2222-4222-8222-222222222222":8192}
        }}});
        let configuration = worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap();
        for offer in [false, true] {
            assert_eq!(
                selection(&configuration, offer).unwrap(),
                Selection::Retained
            );
        }
        let invalid = worker_config::decode(br#"{"workerPoolProvider":{}}"#).unwrap();
        assert!(selection(&invalid, true).is_err());
        assert!(selection(&invalid, false).is_err());
        let absent = worker_config::decode(b"{}").unwrap();
        assert_eq!(selection(&absent, true).unwrap(), Selection::Offer);
        assert_eq!(selection(&absent, false).unwrap(), Selection::Ordinary);
    }
}
