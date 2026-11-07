//! urllib's pinned IDNA2003 host encoding. Only RFC3492 Punycode is delegated
//! to idna; its modern UTS46 domain_to_ascii would change existing endpoints.
mod facts;
mod mapping;
use unicode_normalization::UnicodeNormalization;
#[derive(Debug)]
pub(crate) struct IdnaError;
fn contains(ranges: &[(u32, u32)], value: char) -> bool {
    let cp = u32::from(value);
    let end = ranges.partition_point(|&(start, _)| start <= cp);
    end > 0 && cp <= ranges[end - 1].1
}
fn mapped(entries: &[(u32, &[u32])], value: char) -> Option<String> {
    entries
        .binary_search_by_key(&u32::from(value), |(key, _)| *key)
        .ok()
        .map(|index| {
            entries[index]
                .1
                .iter()
                .map(|&cp| char::from_u32(cp).expect("frozen scalar mapping"))
                .collect()
        })
}
fn normalize32(value: &str) -> String {
    let mut output = String::new();
    let mut assigned = String::new();
    for character in value.chars() {
        if contains(facts::ASSIGNED, character) {
            if let Some(old) = mapped(mapping::CORRECTIONS, character) {
                assigned.push_str(&old);
            } else {
                assigned.push(character);
            }
            continue;
        }
        // A character unassigned in3.2 had combining class0 and no mapping.
        // It remains a normalization boundary even if current Unicode assigns it.
        output.extend(assigned.nfkc());
        assigned.clear();
        output.push(character);
    }
    output.extend(assigned.nfkc());
    output
}
fn b3(value: char) -> String {
    mapped(mapping::B3, value).unwrap_or_else(|| reverie_core::python_lowercase_character(value))
}
fn b2(value: char) -> String {
    let first = b3(value);
    let normalized = normalize32(&first);
    let folded = normalized.chars().map(b3).collect::<String>();
    let second = normalize32(&folded);
    if normalized == second { first } else { second }
}
fn nameprep(value: &str) -> Result<String, IdnaError> {
    let mapped = value
        .chars()
        .filter(|&c| !contains(facts::DELETE, c))
        .map(b2)
        .collect::<String>();
    let normalized = normalize32(&mapped);
    if normalized.chars().any(|c| contains(facts::PROHIBITED, c)) {
        return Err(IdnaError);
    }
    if normalized.chars().any(|c| contains(facts::RANDAL, c)) {
        if normalized.chars().any(|c| contains(facts::LCAT, c)) {
            return Err(IdnaError);
        }
        if !normalized
            .chars()
            .next()
            .is_some_and(|c| contains(facts::RANDAL, c))
            || !normalized
                .chars()
                .next_back()
                .is_some_and(|c| contains(facts::RANDAL, c))
        {
            return Err(IdnaError);
        }
    }
    Ok(normalized)
}
fn label_to_ascii(value: &str) -> Result<String, IdnaError> {
    if value.is_ascii() {
        return checked_label(value.to_owned());
    }
    let normalized = nameprep(value)?;
    if normalized.is_ascii() {
        return checked_label(normalized);
    }
    if normalized.to_ascii_lowercase().starts_with("xn--") {
        return Err(IdnaError);
    }
    let encoded = ::idna::punycode::encode_str(&normalized).ok_or(IdnaError)?;
    checked_label(format!("xn--{encoded}"))
}
fn checked_label(value: String) -> Result<String, IdnaError> {
    if value.is_empty() || value.len() >= 64 {
        Err(IdnaError)
    } else {
        Ok(value)
    }
}
pub(crate) fn host_to_ascii(value: &str) -> Result<String, IdnaError> {
    if value.is_empty() {
        return Ok(String::new());
    }
    let mut labels = value
        .split(['.', '\u{3002}', '\u{ff0e}', '\u{ff61}'])
        .collect::<Vec<_>>();
    let trailing = labels.last() == Some(&"");
    if trailing {
        labels.pop();
    }
    let encoded = labels
        .into_iter()
        .map(label_to_ascii)
        .collect::<Result<Vec<_>, _>>()?
        .join(".");
    Ok(if trailing {
        format!("{encoded}.")
    } else {
        encoded
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_python_idna2003_and_normalization_boundary_vectors() {
        let data: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/memory-idna-python.json"
        ))
        .unwrap();
        for case in data["cases"].as_array().unwrap() {
            let input = case["input"].as_str().unwrap();
            let actual = host_to_ascii(input);
            if let Some(expected) = case["ascii"].as_str() {
                assert_eq!(actual.unwrap(), expected, "input={input:?}");
            } else {
                assert!(actual.is_err(), "input={input:?}, actual={actual:?}");
            }
        }
    }
}
