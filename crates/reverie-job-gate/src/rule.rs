//! The admission rule, with no IO.
//!
//! A job is admitted when
//! `baseline + sum(max(reservation, pss_anon)) + estimate <= limit`, where
//! `baseline = max(0, anon + kernel + sock - sum(pss_anon of admitted jobs))` and
//! `limit = memory.max * permille / 1000`. A running job therefore counts once, at the larger of
//! its reservation and its measured anonymous memory. An admitted job whose usage could not be
//! read counts at its reservation and subtracts nothing from the baseline, which errs safe.

/// The seat's memory facts: the cap and the parts of its usage an OOM kill depends on.
/// Reclaimable page cache is deliberately not here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Facts {
    pub max: u64,
    pub anon: u64,
    pub kernel: u64,
    pub sock: u64,
}

/// One admitted job: what it reserved and, if readable, its tree's proportional anonymous memory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Held {
    pub reservation: u64,
    pub pss_anon: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Admit,
    /// Not now: what the admission would need against the limit.
    Wait {
        need: u64,
        limit: u64,
    },
    /// Never on this seat: the estimate alone exceeds the limit.
    Refuse {
        estimate: u64,
        limit: u64,
    },
}

pub fn limit(facts: &Facts, permille: u32) -> u64 {
    let scaled = u128::from(facts.max) * u128::from(permille.min(1000)) / 1000;
    u64::try_from(scaled).unwrap_or(u64::MAX)
}

pub fn baseline(facts: &Facts, held: &[Held]) -> u64 {
    let used = facts
        .anon
        .saturating_add(facts.kernel)
        .saturating_add(facts.sock);
    let measured = held
        .iter()
        .filter_map(|h| h.pss_anon)
        .fold(0u64, u64::saturating_add);
    used.saturating_sub(measured)
}

pub fn charged(held: &[Held]) -> u64 {
    held.iter()
        .map(|h| h.reservation.max(h.pss_anon.unwrap_or(0)))
        .fold(0u64, u64::saturating_add)
}

pub fn decide(facts: &Facts, held: &[Held], estimate: u64, permille: u32) -> Decision {
    let limit = limit(facts, permille);
    if estimate > limit {
        return Decision::Refuse { estimate, limit };
    }
    let need = baseline(facts, held)
        .saturating_add(charged(held))
        .saturating_add(estimate);
    if need <= limit {
        Decision::Admit
    } else {
        Decision::Wait { need, limit }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1 << 20;
    const FACTS: Facts = Facts {
        max: 1536 * MIB,
        anon: 573 * MIB,
        kernel: 112 * MIB,
        sock: 0,
    };

    #[test]
    fn admits_against_anon_kernel_and_sock_not_page_cache() {
        // 685 MiB used by anon + kernel; 90% of 1536 MiB is 1382.4 MiB, so 600 MiB fits.
        assert_eq!(decide(&FACTS, &[], 600 * MIB, 900), Decision::Admit);
        assert!(matches!(
            decide(&FACTS, &[], 800 * MIB, 900),
            Decision::Wait { .. }
        ));
    }

    #[test]
    fn a_reservation_holds_its_room_before_the_job_reaches_its_peak() {
        let held = [Held {
            reservation: 500 * MIB,
            pss_anon: Some(10 * MIB),
        }];
        // The held job has barely started, but its 500 MiB is still counted.
        assert!(matches!(
            decide(&FACTS, &held, 300 * MIB, 900),
            Decision::Wait { .. }
        ));
        assert_eq!(decide(&FACTS, &held, 150 * MIB, 900), Decision::Admit);
    }

    #[test]
    fn a_running_job_counts_once_at_the_larger_of_reservation_and_usage() {
        let facts = Facts {
            anon: 973 * MIB,
            ..FACTS
        };
        let held = [Held {
            reservation: 200 * MIB,
            pss_anon: Some(400 * MIB),
        }];
        assert_eq!(baseline(&facts, &held), (973 + 112 - 400) * MIB);
        assert_eq!(charged(&held), 400 * MIB);
        // 685 + 400 + 290 = 1375 <= 1382.4: admitted, so the job's 400 MiB was not counted twice.
        assert_eq!(decide(&facts, &held, 290 * MIB, 900), Decision::Admit);
    }

    #[test]
    fn unreadable_usage_counts_the_reservation_and_subtracts_nothing() {
        let held = [Held {
            reservation: 300 * MIB,
            pss_anon: None,
        }];
        assert_eq!(baseline(&FACTS, &held), 685 * MIB);
        assert_eq!(charged(&held), 300 * MIB);
    }

    #[test]
    fn the_baseline_never_goes_below_zero() {
        let held = [Held {
            reservation: 0,
            pss_anon: Some(5000 * MIB),
        }];
        assert_eq!(baseline(&FACTS, &held), 0);
    }

    #[test]
    fn an_estimate_above_the_limit_is_refused_outright() {
        assert_eq!(
            decide(&FACTS, &[], 1400 * MIB, 900),
            Decision::Refuse {
                estimate: 1400 * MIB,
                limit: limit(&FACTS, 900)
            }
        );
    }

    #[test]
    fn the_limit_is_a_permille_of_the_cap_and_never_above_it() {
        assert_eq!(limit(&FACTS, 1000), 1536 * MIB);
        assert_eq!(limit(&FACTS, 5000), 1536 * MIB);
        assert_eq!(limit(&FACTS, 500), 768 * MIB);
    }
}
