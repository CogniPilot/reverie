//! Python 3.13/Unicode15.1 int/string compatibility for subordinate-ID data.
use super::*;
use crate::legacy_json::Number;
use reverie_core::rootless::SubordinateId;
/// Exact signed result of Python int(label), not an admitted host mapping.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImageInteger {
    negative: bool,
    magnitude: SubordinateId,
}
impl ImageInteger {
    pub fn decimal(&self) -> String {
        format!(
            "{}{}",
            if self.negative { "-" } else { "" },
            self.magnitude.as_str()
        )
    }
    pub fn nonnegative(&self) -> Option<&SubordinateId> {
        (!self.negative).then_some(&self.magnitude)
    }
}
fn signed(negative: bool, magnitude: SubordinateId) -> ImageInteger {
    ImageInteger {
        negative: negative && !magnitude.is_zero(),
        magnitude,
    }
}
const DECIMAL_ZEROES: &[u32] = &[
    0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66,
    0xde6, 0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90,
    0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10,
    0x104a0, 0x10d30, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650,
    0x116c0, 0x11730, 0x118e0, 0x11950, 0x11c50, 0x11d50, 0x11da0, 0x11f50, 0x16a60, 0x16ac0,
    0x16b50, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e950,
    0x1fbf0,
];
fn decimal(point: u32) -> Option<u8> {
    DECIMAL_ZEROES
        .iter()
        .find(|&&zero| point >= zero && point < zero + 10)
        .map(|zero| (point - zero) as u8)
}
pub(super) fn is_digit(point: u32) -> bool {
    decimal(point).is_some()
        || [
            (178, 179),
            (185, 185),
            (4969, 4977),
            (6618, 6618),
            (8304, 8304),
            (8308, 8313),
            (8320, 8329),
            (9312, 9320),
            (9332, 9340),
            (9352, 9360),
            (9450, 9450),
            (9461, 9469),
            (9471, 9471),
            (10102, 10110),
            (10112, 10120),
            (10122, 10130),
            (68160, 68163),
            (69216, 69224),
            (69714, 69722),
            (127232, 127242),
        ]
        .iter()
        .any(|&(a, b)| (a..=b).contains(&point))
}
fn whitespace(point: u32) -> bool {
    matches!(point, 9..=13 | 32 | 0x85 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000)
}
pub(super) fn string_integer(points: &[u32]) -> Result<ImageInteger> {
    let begin = points
        .iter()
        .position(|&p| !whitespace(p))
        .ok_or(RootlessError::SubIds)?;
    let end = points
        .iter()
        .rposition(|&p| !whitespace(p))
        .ok_or(RootlessError::SubIds)?
        + 1;
    let points = &points[begin..end];
    let (negative, points) = match points.first() {
        Some(43) => (false, &points[1..]),
        Some(45) => (true, &points[1..]),
        _ => (false, points),
    };
    let mut digits = String::new();
    let mut previous_digit = false;
    for (index, &point) in points.iter().enumerate() {
        if point == 95
            && previous_digit
            && points.get(index + 1).is_some_and(|&p| decimal(p).is_some())
        {
            previous_digit = false;
            continue;
        }
        let digit = decimal(point).ok_or(RootlessError::SubIds)?;
        digits.push(char::from(b'0' + digit));
        previous_digit = true;
    }
    if digits.len() > crate::legacy_json::DEFAULT_INT_MAX_DIGITS {
        return Err(RootlessError::SubIds);
    }
    let integer = SubordinateId::parse(&digits).ok_or(RootlessError::SubIds)?;
    Ok(signed(negative, integer))
}
pub(super) fn integer(value: Option<&Value>) -> Result<ImageInteger> {
    let value = value.ok_or(RootlessError::SubIds)?;
    let text = match &value.0 {
        Node::String(value) => return string_integer(&value.0),
        Node::Bool(value) => {
            if *value {
                "1".into()
            } else {
                "0".into()
            }
        }
        Node::Number(Number::Integer(value)) => value.clone(),
        Node::Number(Number::Float(value)) => {
            crate::legacy_json::numeric_key(&Node::Number(Number::Float(value.trunc())))
                .ok_or(RootlessError::SubIds)?
        }
        _ => return Err(RootlessError::SubIds),
    };
    let (negative, magnitude) = text
        .strip_prefix('-')
        .map_or((false, text.as_str()), |value| (true, value));
    Ok(signed(
        negative,
        SubordinateId::parse(magnitude).ok_or(RootlessError::SubIds)?,
    ))
}
