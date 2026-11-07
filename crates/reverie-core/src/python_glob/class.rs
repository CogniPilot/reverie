//! Normalize Python's bracket grammar, including discarded descending ranges.
pub(super) struct Class {
    negated: bool,
    ranges: Vec<(u32, u32)>,
}
enum Part {
    Point(u32),
    Range,
}
impl Class {
    pub(super) fn compile(raw: &[u32]) -> Self {
        let chunks = chunks(raw);
        let mut parts = Vec::new();
        for (index, chunk) in chunks.into_iter().enumerate() {
            if index > 0 {
                parts.push(Part::Range);
            }
            parts.extend(chunk.into_iter().map(Part::Point));
        }
        let negated = matches!(parts.first(), Some(Part::Point(33)));
        if negated {
            parts.remove(0);
        }
        let mut ranges = Vec::new();
        let mut at = 0;
        while let Some(part) = parts.get(at) {
            if let (Part::Point(first), Some(Part::Range), Some(Part::Point(last))) =
                (part, parts.get(at + 1), parts.get(at + 2))
            {
                ranges.push((*first, *last));
                at += 3;
            } else {
                let point = match part {
                    Part::Point(value) => *value,
                    Part::Range => 45,
                };
                ranges.push((point, point));
                at += 1;
            }
        }
        Self { negated, ranges }
    }
    pub(super) fn accepts(&self, point: u32) -> bool {
        self.negated
            != self
                .ranges
                .iter()
                .any(|&(first, last)| first <= point && point <= last)
    }
}
fn chunks(raw: &[u32]) -> Vec<Vec<u32>> {
    let mut result = Vec::new();
    let mut start = 0;
    let mut search = if raw.first() == Some(&33) { 2 } else { 1 };
    while let Some(offset) = raw
        .get(search..)
        .and_then(|tail| tail.iter().position(|&cp| cp == 45))
    {
        let at = search + offset;
        result.push(raw[start..at].to_vec());
        start = at + 1;
        search = at + 3;
    }
    if start < raw.len() {
        result.push(raw[start..].to_vec());
    } else if let Some(last) = result.last_mut() {
        last.push(45);
    }
    discard_descending(&mut result);
    result
}
fn discard_descending(chunks: &mut Vec<Vec<u32>>) {
    for at in (1..chunks.len()).rev() {
        if chunks[at - 1].last() > chunks[at].first() {
            chunks[at - 1].pop();
            let tail = chunks.remove(at);
            chunks[at - 1].extend_from_slice(&tail[1..]);
        }
    }
}
