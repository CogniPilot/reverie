use reverie_core::ValueError;
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use reverie_core::profiles::{ProfileBinding, ProfileDocument, ResourceProfile};
use reverie_core::resource_projection::{ProfileStageRequest, ProjectionError, ResourceProjection};
use reverie_core::resources::{BudgetMode, CpuQuota, PoolLimits, ResourcePolicy, ResourceTemplate};
use reverie_core::revision::{Generation, ObservedProfileVersion, ProfileVersion, StoreRevision};
use std::collections::BTreeMap;

fn employee(number: usize) -> ProfileEmployeeId {
    ProfileEmployeeId::parse(&format!("{number:08x}-0000-0000-0000-000000000000")).unwrap()
}
fn session(number: usize) -> ProfileSessionId {
    ProfileSessionId::parse(&format!("{number:08x}-0000-0000-0000-000000000000")).unwrap()
}
fn template(memory: u32, pool_memory: u32, cpu: CpuQuota) -> ResourceTemplate {
    ResourceTemplate::try_new(BudgetMode::Admission, memory, 64, cpu, pool_memory, 128).unwrap()
}
fn standard() -> ResourceTemplate {
    template(512, 1024, CpuQuota::from_integer(0).unwrap())
}
fn binding(current: usize, target: usize) -> ProfileBinding {
    ProfileBinding::try_new(
        employee(1),
        session(current),
        session(target),
        Generation::try_new(1).unwrap(),
        Generation::try_new(2).unwrap(),
    )
    .unwrap()
}
fn document(binding: ProfileBinding, resources: ResourcePolicy) -> ProfileDocument {
    ProfileDocument::try_new(
        StoreRevision::try_new(7).unwrap(),
        BTreeMap::from([(
            employee(1),
            ResourceProfile::new(ProfileVersion::try_new(3).unwrap(), resources, binding),
        )]),
    )
    .unwrap()
}
fn request(
    binding: ProfileBinding,
    revision: u64,
    version: u64,
    owners: &BTreeMap<ProfileSessionId, ProfileEmployeeId>,
) -> ProfileStageRequest {
    ProfileStageRequest::try_new(
        employee(1),
        binding,
        StoreRevision::try_new(revision).unwrap(),
        ObservedProfileVersion::try_new(version).unwrap(),
        owners,
    )
    .unwrap()
}
fn owners() -> BTreeMap<ProfileSessionId, ProfileEmployeeId> {
    BTreeMap::from([(session(10), employee(1)), (session(11), employee(1))])
}
fn empty_projection(pool: Option<PoolLimits>) -> ResourceProjection {
    ResourceProjection::try_new(BTreeMap::new(), BTreeMap::new(), pool).unwrap()
}

#[test]
fn templates_check_fields_before_overriding_only_the_pool_cross_limit() {
    let cpu = CpuQuota::from_float(-0.0).unwrap();
    let local = template(4096, 1024, cpu);
    assert_eq!(local.resolve(None), Err(ValueError::ResourceLimit));
    let global = PoolLimits::try_new(8192, 1024).unwrap();
    let resolved = local.resolve(Some(global)).unwrap();
    assert_eq!(resolved.memory_mib(), 4096);
    assert_eq!(resolved.pool_memory_mib(), 8192);
    assert_eq!(resolved.pool_tasks_max(), 1024);
    assert_eq!(resolved.cpus(), cpu);
    assert_eq!(local.pool_memory_mib(), 1024);
    assert!(ResourcePolicy::try_new(BudgetMode::Admission, 4096, 64, cpu, 1024, 128).is_err());
    assert!(ResourceTemplate::try_new(BudgetMode::Admission, 511, 64, cpu, 1024, 128).is_err());
    assert!(ResourceTemplate::try_new(BudgetMode::Pool, 1_048_577, 64, cpu, 1024, 128).is_err());
    assert!(ResourceTemplate::try_new(BudgetMode::Pool, 0, 63, cpu, 1024, 128).is_err());
    for (memory, tasks) in [(511, 128), (1_048_577, 128), (512, 127), (512, 32769)] {
        assert!(PoolLimits::try_new(memory, tasks).is_err());
    }
    for cpu in [
        CpuQuota::from_integer(1).unwrap(),
        CpuQuota::from_float(1.0).unwrap(),
        cpu,
    ] {
        assert_eq!(template(512, 1024, cpu).resolve(None).unwrap().cpus(), cpu);
    }
}

#[test]
fn every_map_entry_is_validated_using_reservation_key_presence() {
    let stale = template(4096, 1024, CpuQuota::from_integer(0).unwrap());
    let sessions = BTreeMap::from([(session(8), stale.clone())]);
    let employees = BTreeMap::from([(employee(8), stale.clone())]);
    assert!(ResourceProjection::try_new(sessions.clone(), BTreeMap::new(), None).is_err());
    assert!(ResourceProjection::try_new(BTreeMap::new(), employees.clone(), None).is_err());
    let pool = PoolLimits::try_new(8192, 1024).unwrap();
    let projection = ResourceProjection::try_new(sessions, employees, Some(pool)).unwrap();
    assert_eq!(projection.sessions().get(&session(8)), Some(&stale));
    assert_eq!(projection.employees().get(&employee(8)), Some(&stale));
    assert_eq!(projection.reservation_pool(), Some(pool));
    assert!(
        ResourceProjection::try_new(
            projection.sessions().clone(),
            projection.employees().clone(),
            Some(PoolLimits::try_new(2048, 128).unwrap()),
        )
        .is_err()
    );
}

#[test]
fn stage_changes_only_selected_maps_and_retains_original_profile_and_inputs() {
    let cpu = CpuQuota::from_float(-0.0).unwrap();
    let canonical = template(2048, 4096, cpu).resolve(None).unwrap();
    let document = document(binding(10, 11), canonical.clone());
    let stale = template(4096, 1024, CpuQuota::from_float(1.0).unwrap());
    let before = ResourceProjection::try_new(
        BTreeMap::from([(session(10), stale.clone()), (session(11), standard())]),
        BTreeMap::from([(employee(1), standard()), (employee(2), stale.clone())]),
        Some(PoolLimits::try_new(8192, 512).unwrap()),
    )
    .unwrap();
    let copy = before.clone();
    let staged = before
        .stage(&document, &request(binding(10, 11), 7, 3, &owners()))
        .unwrap();
    let after = staged.projection();
    assert_eq!(before, copy);
    assert_eq!(after.sessions().get(&session(10)), Some(&stale));
    assert_eq!(after.employees().get(&employee(2)), Some(&stale));
    let selected = after.employees().get(&employee(1)).unwrap();
    assert_eq!(after.sessions().get(&session(11)), Some(selected));
    assert_eq!(selected.memory_mib(), 2048);
    assert_eq!(selected.pool_memory_mib(), 8192);
    assert_eq!(selected.pool_tasks_max(), 512);
    assert_eq!(selected.cpus(), cpu);
    assert_eq!(staged.profile().resources(), &canonical);
    assert_eq!(
        staged.profile(),
        document.profiles().get(&employee(1)).unwrap()
    );
    assert_eq!(staged.store_revision().get(), 7);
    assert_eq!(staged.profile_version().get(), 3);
    assert_eq!(staged.target_session(), &session(11));
    assert_eq!(document.revision().get(), 7);
}

#[test]
fn stage_requires_exact_revision_version_and_binding_without_defaults() {
    let projection = empty_projection(None);
    let document = document(binding(10, 11), standard().resolve(None).unwrap());
    for (change, expected) in [
        (
            request(binding(10, 11), 6, 3, &owners()),
            ProjectionError::StaleStoreRevision,
        ),
        (
            request(binding(10, 11), 7, 2, &owners()),
            ProjectionError::StaleProfileOrBinding,
        ),
        (
            request(binding(10, 12), 7, 3, &owners()),
            ProjectionError::StaleProfileOrBinding,
        ),
    ] {
        assert_eq!(projection.stage(&document, &change), Err(expected));
    }
    assert_eq!(
        projection.stage(
            &ProfileDocument::empty(),
            &request(binding(10, 11), 0, 0, &owners()),
        ),
        Err(ProjectionError::PendingProfileMissingNoDefault)
    );
    assert_eq!(
        ProfileStageRequest::try_new(
            employee(2),
            binding(10, 11),
            StoreRevision::ZERO,
            ObservedProfileVersion::try_new(0).unwrap(),
            &owners(),
        ),
        Err(ProjectionError::EmployeeBinding)
    );
}

#[test]
fn stage_checks_both_session_owners_and_copies_the_observation() {
    let projection = empty_projection(None);
    let document = document(binding(10, 11), standard().resolve(None).unwrap());
    for sid in [10, 11] {
        let mut missing = owners();
        missing.remove(&session(sid));
        let mut foreign = owners();
        foreign.insert(session(sid), employee(2));
        for map in [missing, foreign] {
            assert_eq!(
                projection.stage(&document, &request(binding(10, 11), 7, 3, &map)),
                Err(ProjectionError::SidOwnerMismatch)
            );
        }
    }
    let mut map = owners();
    let observed = request(binding(10, 11), 7, 3, &map);
    map.insert(session(11), employee(2));
    assert!(projection.stage(&document, &observed).is_ok());
    assert_eq!(
        projection.stage(&document, &request(binding(10, 11), 7, 3, &map)),
        Err(ProjectionError::SidOwnerMismatch)
    );
}

#[test]
fn same_session_binding_is_accepted_and_global_pool_shrink_is_rejected() {
    let document = document(
        binding(10, 10),
        template(2048, 4096, CpuQuota::from_integer(1).unwrap())
            .resolve(None)
            .unwrap(),
    );
    let observed = request(binding(10, 10), 7, 3, &owners());
    assert!(empty_projection(None).stage(&document, &observed).is_ok());
    assert_eq!(
        empty_projection(Some(PoolLimits::try_new(1024, 128).unwrap())).stage(&document, &observed),
        Err(ProjectionError::InvalidValue(ValueError::ResourceLimit))
    );
}

#[test]
fn session_counts_are_checked_before_and_after_inserting_target() {
    let sessions = (100..132)
        .map(|number| (session(number), standard()))
        .collect();
    let full = ResourceProjection::try_new(sessions, BTreeMap::new(), None).unwrap();
    let document = document(binding(10, 11), standard().resolve(None).unwrap());
    assert_eq!(
        full.stage(&document, &request(binding(10, 11), 7, 3, &owners())),
        Err(ProjectionError::SessionPolicyCount)
    );
    assert_eq!(full.sessions().len(), 32);
    let mut oversized = full.sessions().clone();
    oversized.insert(session(11), standard());
    assert_eq!(
        ResourceProjection::try_new(oversized, BTreeMap::new(), None),
        Err(ProjectionError::SessionPolicyCount)
    );
    let mut replacing = full.sessions().clone();
    replacing.remove(&session(100));
    replacing.insert(session(11), standard());
    assert!(
        ResourceProjection::try_new(replacing, BTreeMap::new(), None)
            .unwrap()
            .stage(&document, &request(binding(10, 11), 7, 3, &owners()))
            .is_ok()
    );
}

#[test]
fn employee_counts_are_checked_before_and_after_inserting_selected_employee() {
    let employees = (100..356)
        .map(|number| (employee(number), standard()))
        .collect();
    let full = ResourceProjection::try_new(BTreeMap::new(), employees, None).unwrap();
    let document = document(binding(10, 11), standard().resolve(None).unwrap());
    assert_eq!(
        full.stage(&document, &request(binding(10, 11), 7, 3, &owners())),
        Err(ProjectionError::EmployeePolicyCount)
    );
    assert_eq!(full.employees().len(), 256);
    let mut oversized = full.employees().clone();
    oversized.insert(employee(1), standard());
    assert_eq!(
        ResourceProjection::try_new(BTreeMap::new(), oversized, None),
        Err(ProjectionError::EmployeePolicyCount)
    );
    let mut replacing = full.employees().clone();
    replacing.remove(&employee(100));
    replacing.insert(employee(1), standard());
    assert!(
        ResourceProjection::try_new(BTreeMap::new(), replacing, None)
            .unwrap()
            .stage(&document, &request(binding(10, 11), 7, 3, &owners()))
            .is_ok()
    );
}
