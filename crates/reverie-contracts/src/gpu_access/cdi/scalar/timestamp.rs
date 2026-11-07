use super::*;
pub(super) fn valid(value: &str) -> bool {
    // Python re's final '$' also matches before ONE terminal LF. Two final
    // linefeeds still refuse; the fixed expression remains otherwise exact.
    let value = value.strip_suffix('\n').unwrap_or(value);
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let expression=PATTERN.get_or_init(||Regex::new(r"\A([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:[Tt]|[ \t]+)([0-9]{1,2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]*)?(?:[ \t]*(Z|([-+])([0-9]{1,2})(?::([0-9]{2}))?))?)?\z").expect("fixed timestamp grammar"));
    let Some(fields) = expression.captures(value) else {
        return false;
    };
    let number = |index| {
        fields
            .get(index)
            .map_or(Some(0), |value| value.as_str().parse::<u32>().ok())
    };
    let (Some(year), Some(month), Some(day)) = (number(1), number(2), number(3)) else {
        return false;
    };
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let maximum = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        _ => return false,
    };
    year > 0
        && day > 0
        && day <= maximum
        && number(4).is_some_and(|value| value < 24)
        && number(5).is_some_and(|value| value < 60)
        && number(6).is_some_and(|value| value < 60)
        && number(9)
            .zip(number(10))
            .is_some_and(|(hour, minute)| hour * 60 + minute < 24 * 60)
}
