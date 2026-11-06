use crate::python_text::decimal_point;
pub(super) fn not_phone(text: &[u32]) -> bool {
    ipv4(text) || version(text) || date(text)
}
fn octet(text: &[u32]) -> bool {
    match text {
        [point] => decimal_point(*point),
        [first, last] => (49..=57).contains(first) && decimal_point(*last),
        [49, middle, last] => decimal_point(*middle) && decimal_point(*last),
        [50, middle, last] if (48..=52).contains(middle) => decimal_point(*last),
        [50, 53, last] => (48..=53).contains(last),
        _ => false,
    }
}
fn ipv4(text: &[u32]) -> bool {
    let suffix = text.iter().position(|&point| matches!(point, 47 | 58));
    let address = if let Some(index) = suffix {
        let maximum = if text[index] == 47 { 2 } else { 5 };
        let count = text.len() - index - 1;
        if count == 0
            || count > maximum
            || !text[index + 1..].iter().all(|&point| decimal_point(point))
        {
            return false;
        }
        &text[..index]
    } else {
        text
    };
    let parts = address.split(|&point| point == 46).collect::<Vec<_>>();
    if parts.len() == 4 && parts.iter().all(|part| octet(part)) {
        return true;
    }
    if suffix.is_some() {
        return false;
    }
    let numeric = parts.iter().take_while(|part| octet(part)).count();
    (2..=3).contains(&numeric)
        && (1..=2).contains(&(parts.len() - numeric))
        && parts[numeric..]
            .iter()
            .all(|part| matches!(*part, [88 | 120 | 42]))
}
fn version(text: &[u32]) -> bool {
    if !text.first().is_some_and(|&point| matches!(point, 86 | 118)) {
        return false;
    }
    let parts = text[1..].split(|&point| point == 46).collect::<Vec<_>>();
    (2..=4).contains(&parts.len())
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.iter().all(|&point| decimal_point(point)))
}
fn date(text: &[u32]) -> bool {
    text.len() == 10
        && text[4] == 45
        && text[7] == 45
        && text
            .iter()
            .enumerate()
            .all(|(index, &point)| matches!(index, 4 | 7) || decimal_point(point))
}
