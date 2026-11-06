use reverie_core::ValueError;
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use reverie_core::profiles::{
    ProfileBinding, ProfileDocument, ProfileError, ProfilePutIntent, ResourceProfile,
};
use reverie_core::resources::{BudgetMode, CpuQuota, ResourcePolicy};
use reverie_core::revision::{
    Generation, JS_SAFE_MAX, ObservedProfileVersion, ProfileVersion, StoreRevision,
};
use std::collections::BTreeMap;

fn id(number: usize) -> ProfileEmployeeId {
    ProfileEmployeeId::parse(&format!("{number:08x}-0000-0000-0000-000000000000")).unwrap()
}
fn binding(employee: ProfileEmployeeId, generation: u64) -> ProfileBinding {
    let session = ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap();
    ProfileBinding::try_new(
        employee,
        session.clone(),
        session,
        Generation::try_new(1).unwrap(),
        Generation::try_new(generation).unwrap(),
    )
    .unwrap()
}
fn resources() -> ResourcePolicy {
    ResourcePolicy::try_new(
        BudgetMode::Admission,
        512,
        64,
        CpuQuota::from_float(-0.0).unwrap(),
        1024,
        128,
    )
    .unwrap()
}
fn intent(
    employee: ProfileEmployeeId,
    revision: u64,
    version: u64,
    previous: Option<ProfileBinding>,
) -> ProfilePutIntent {
    ProfilePutIntent::try_new(
        employee.clone(),
        resources(),
        binding(employee, 2),
        StoreRevision::try_new(revision).unwrap(),
        ObservedProfileVersion::try_new(version).unwrap(),
        previous,
    )
    .unwrap()
}

#[test]
fn pure_cas_projection_preserves_original_and_requires_all_three_expectations() {
    let empty = ProfileDocument::empty();
    let created = empty.apply(&intent(id(1), 0, 0, None)).unwrap();
    assert_eq!(empty.revision().get(), 0);
    assert!(empty.profiles().is_empty());
    assert_eq!(created.revision().get(), 1);
    assert_eq!(created.profiles().get(&id(1)).unwrap().version().get(), 1);
    assert_eq!(
        created.apply(&intent(id(1), 0, 1, Some(binding(id(1), 2)))),
        Err(ProfileError::StaleStoreRevision)
    );
    assert_eq!(
        created.apply(&intent(id(1), 1, 0, Some(binding(id(1), 2)))),
        Err(ProfileError::StaleProfileVersion)
    );
    assert_eq!(
        created.apply(&intent(id(1), 1, 1, Some(binding(id(1), 1)))),
        Err(ProfileError::StaleIdentityBinding)
    );
    let updated = created
        .apply(&intent(id(1), 1, 1, Some(binding(id(1), 2))))
        .unwrap();
    assert_eq!(updated.profiles().get(&id(1)).unwrap().version().get(), 2);
    assert_eq!(created.revision().get(), 1);
}

#[test]
fn rejects_mismatched_employee_and_regressing_generation_before_a_projection() {
    assert_eq!(
        ProfilePutIntent::try_new(
            id(1),
            resources(),
            binding(id(2), 2),
            StoreRevision::ZERO,
            ObservedProfileVersion::try_new(0).unwrap(),
            None
        ),
        Err(ProfileError::EmployeeBinding)
    );
    let session = ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap();
    assert_eq!(
        ProfileBinding::try_new(
            id(1),
            session.clone(),
            session,
            Generation::try_new(2).unwrap(),
            Generation::try_new(1).unwrap()
        ),
        Err(ValueError::GenerationRegression)
    );
}

#[test]
fn counter_overflow_and_profile_count_leave_the_prior_document_intact() {
    let max = ProfileDocument::try_new(
        StoreRevision::try_new(JS_SAFE_MAX).unwrap(),
        BTreeMap::new(),
    )
    .unwrap();
    assert!(max.apply(&intent(id(1), JS_SAFE_MAX, 0, None)).is_err());
    let profiles = (0..256)
        .map(|number| {
            (
                id(number),
                ResourceProfile::new(
                    ProfileVersion::try_new(1).unwrap(),
                    resources(),
                    binding(id(number), 2),
                ),
            )
        })
        .collect();
    let full = ProfileDocument::try_new(StoreRevision::ZERO, profiles).unwrap();
    assert_eq!(
        full.apply(&intent(id(256), 0, 0, None)),
        Err(ProfileError::ProfileCount)
    );
    assert_eq!(full.profiles().len(), 256);
}
