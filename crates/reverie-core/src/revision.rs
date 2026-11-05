use crate::ValueError;

pub const JS_SAFE_MAX: u64 = 9_007_199_254_740_991;

macro_rules! counter {
    ($name:ident, $minimum:expr) => {
        #[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
        pub struct $name(u64);
        impl $name {
            pub fn try_new(value: u64) -> Result<Self, ValueError> {
                if !($minimum..=JS_SAFE_MAX).contains(&value) {
                    return Err(ValueError::CounterRange);
                }
                Ok(Self(value))
            }
            pub fn get(self) -> u64 {
                self.0
            }
            pub fn checked_next(self) -> Result<Self, ValueError> {
                Self::try_new(self.0.checked_add(1).ok_or(ValueError::CounterRange)?)
            }
        }
    };
}
counter!(StoreRevision, 0);
counter!(ProfileVersion, 1);
counter!(ObservedProfileVersion, 0);
counter!(Generation, 1);
impl StoreRevision {
    pub const ZERO: Self = Self(0);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn counters_distinguish_absence_from_a_published_profile() {
        assert!(ObservedProfileVersion::try_new(0).is_ok());
        assert!(StoreRevision::try_new(0).is_ok());
        assert!(ProfileVersion::try_new(0).is_err());
        assert!(Generation::try_new(0).is_err());
        assert!(
            StoreRevision::try_new(JS_SAFE_MAX)
                .unwrap()
                .checked_next()
                .is_err()
        );
        assert!(Generation::try_new(JS_SAFE_MAX + 1).is_err());
    }
}
