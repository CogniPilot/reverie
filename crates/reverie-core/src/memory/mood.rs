use super::numeric::clamp;

const BASELINE_VALENCE: f64 = 0.2;
const HALF_LIFE_HOURS: f64 = 6.0;

#[derive(Clone, Copy, Debug)]
pub struct Mood {
    valence: f64,
    arousal: f64,
    updated_at: f64,
}

impl Default for Mood {
    fn default() -> Self {
        Self::new(BASELINE_VALENCE, 0.0, 0.0)
    }
}

impl Mood {
    pub fn new(valence: f64, arousal: f64, updated_at: f64) -> Self {
        Self {
            valence,
            arousal,
            updated_at,
        }
    }

    pub fn values(self) -> (f64, f64, f64) {
        (self.valence, self.arousal, self.updated_at)
    }

    pub fn decayed(mut self, now: f64) -> Self {
        // An unset update timestamp stamps the current state without moving it.
        if self.updated_at > 0.0 || self.updated_at.is_nan() {
            let hours = ((now - self.updated_at) / 3600.0).max(0.0);
            let decay = 0.5_f64.powf(hours / HALF_LIFE_HOURS);
            self.valence = BASELINE_VALENCE + (self.valence - BASELINE_VALENCE) * decay;
            self.arousal = 0.0 + self.arousal * decay;
        }
        self.updated_at = now;
        self
    }

    /// Apply a dream's tone to the captured, decayed mood from its prompt.
    pub fn nudge_tone(self, tone: &str, weight: f64, now: f64) -> Self {
        let (valence, arousal) = match tone {
            "warm" => (0.15, 0.0),
            "playful" => (0.10, 0.10),
            "calm" => (0.05, -0.15),
            "strange" => (0.0, 0.05),
            "anxious" => (-0.15, 0.15),
            "melancholy" => (-0.15, -0.10),
            _ => (0.0, 0.0),
        };
        let current = self.decayed(now);
        Self::new(
            clamp(current.valence + valence * weight, -1.0, 1.0),
            clamp(current.arousal + arousal * weight, -1.0, 1.0),
            now,
        )
    }

    pub fn describe(self) -> &'static str {
        let v = self.valence;
        let (active, calm) = if v > 0.45 {
            ("bright and happy", "warm and content")
        } else if v > 0.1 {
            ("playful", "content and easy")
        } else if v > -0.1 {
            ("restless", "quiet and even")
        } else if v > -0.45 {
            ("on edge", "a little wistful")
        } else {
            ("anxious", "low and tired")
        };
        if self.arousal > 0.2 { active } else { calm }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_life_and_dream_nudges_preserve_the_mood_baseline_and_limits() {
        let now = 1_021_600.0;
        let decayed = Mood::new(0.9, 0.9, 1_000_000.0).decayed(now);
        let (v, a, timestamp) = decayed.values();
        assert!((v - 0.55).abs() < 1e-12);
        assert_eq!((a, timestamp), (0.45, now));
        let (v, a, _) = decayed.nudge_tone("anxious", 1.0, now).values();
        assert!((v - 0.4).abs() < 1e-12);
        assert!((a - 0.60).abs() < 1e-12);
        let (v, a, _) = decayed.nudge_tone("playful", 50.0, now).values();
        assert_eq!((v, a), (1.0, 1.0));
    }

    #[test]
    fn description_keeps_existing_phrases_and_strict_boundaries() {
        assert_eq!(Mood::default().describe(), "content and easy");
        assert_eq!(Mood::new(0.9, 0.5, 0.0).describe(), "bright and happy");
        assert_eq!(Mood::new(-0.9, -0.5, 0.0).describe(), "low and tired");
        assert_eq!(Mood::new(0.45, 0.2, 0.0).describe(), "content and easy");
        assert_eq!(Mood::new(-0.1, 0.5, 0.0).describe(), "on edge");
    }
}
