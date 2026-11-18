use super::recency_score;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DreamTone {
    Warm,
    Playful,
    Calm,
    #[default]
    Strange,
    Anxious,
    Melancholy,
}

impl DreamTone {
    pub const ALL: [Self; 6] = [
        Self::Warm,
        Self::Playful,
        Self::Calm,
        Self::Strange,
        Self::Anxious,
        Self::Melancholy,
    ];

    pub fn parse(tone: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|value| value.as_str() == tone)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Warm => "warm",
            Self::Playful => "playful",
            Self::Calm => "calm",
            Self::Strange => "strange",
            Self::Anxious => "anxious",
            Self::Melancholy => "melancholy",
        }
    }

    pub(super) fn offsets(self) -> (f64, f64) {
        match self {
            Self::Warm => (0.15, 0.0),
            Self::Playful => (0.10, 0.10),
            Self::Calm => (0.05, -0.15),
            Self::Strange => (0.0, 0.05),
            Self::Anxious => (-0.15, 0.15),
            Self::Melancholy => (-0.15, -0.10),
        }
    }
}

#[derive(Clone, Copy)]
pub struct DreamEpisode {
    pub id: i64,
    pub created_at: f64,
    pub importance: f64,
    pub idle: bool,
}

const RECENT_CHOICES: usize = 4;
const OLD_AGE_SECONDS: f64 = 48.0 * 3600.0;
pub const DREAM_DRAWS: usize = RECENT_CHOICES + 1;

pub fn dream_sample(
    rows: &[DreamEpisode],
    now: f64,
    draws: [f64; DREAM_DRAWS],
) -> Option<Vec<i64>> {
    let mut pool = rows
        .iter()
        .filter(|row| !row.idle)
        .map(|row| {
            let weight =
                recency_score(row.created_at, now, 0.98).ok()? * (row.importance / 10.0).max(0.1);
            Some((row, weight))
        })
        .collect::<Option<Vec<_>>>()?;
    let mut selected = Vec::with_capacity(DREAM_DRAWS);
    for draw in draws.into_iter().take(RECENT_CHOICES).take(pool.len()) {
        let cumulative = pool
            .iter()
            .scan(0.0, |sum, (_, weight)| {
                *sum += weight;
                Some(*sum)
            })
            .collect::<Vec<_>>();
        let total = *cumulative.last()?;
        if total <= 0.0 || !total.is_finite() {
            return None;
        }
        let index = cumulative[..cumulative.len() - 1].partition_point(|sum| *sum <= draw * total);
        selected.push(pool.remove(index).0);
    }
    let older = pool
        .into_iter()
        .map(|(row, _)| row)
        .filter(|row| now - row.created_at > OLD_AGE_SECONDS)
        .collect::<Vec<_>>();
    let older_index = (draws[RECENT_CHOICES] * older.len() as f64) as usize;
    selected.extend(older.get(older_index).copied());
    selected.sort_by(|left, right| left.created_at.total_cmp(&right.created_at));
    Some(selected.into_iter().map(|row| row.id).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sampling_picks_four_weighted_distinct_episodes_and_an_old_one_in_chronological_order() {
        let now = 1_000_000.0;
        let rows = (0..12)
            .map(|id| DreamEpisode {
                id,
                created_at: now - ((if id < 7 { id } else { id + 100 }) * 3600) as f64,
                importance: if id == 1 { 9.0 } else { 2.0 },
                idle: id == 0,
            })
            .collect::<Vec<_>>();
        for index in 0..100 {
            let draw = f64::from(index) / 100.0;
            let ids = dream_sample(&rows, now, [draw; DREAM_DRAWS]).unwrap();
            assert_eq!(ids.len(), DREAM_DRAWS);
            assert!(ids[0] >= 7);
            assert!(!ids.contains(&0));
            assert!(ids.windows(2).all(|pair| pair[0] > pair[1]));
        }
        let hit_count = |id| {
            (0..100)
                .filter(|index| {
                    let draw = f64::from(*index) / 100.0;
                    dream_sample(&rows, now, [draw, 0.11, 0.35, 0.67, 0.9])
                        .unwrap()
                        .contains(&id)
                })
                .count()
        };
        assert!(hit_count(1) > hit_count(4));
        let all_old_selected = dream_sample(&rows[..10], now, [0.999; DREAM_DRAWS]).unwrap();
        assert_eq!(all_old_selected.len(), RECENT_CHOICES);
        assert!(
            dream_sample(&[], now, [0.0; DREAM_DRAWS])
                .unwrap()
                .is_empty()
        );
    }
}
