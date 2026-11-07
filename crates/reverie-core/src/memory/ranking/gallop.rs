use super::Sorter;
impl Sorter<'_> {
    pub(super) fn gallop_left(&self, key: usize, values: &[usize], hint: usize) -> usize {
        let mut last = 0;
        let mut offset = 1;
        let (mut left, mut right) = if self.less(values[hint], key) {
            let max = values.len() - hint;
            while offset < max && self.less(values[hint + offset], key) {
                last = offset;
                offset = offset.saturating_mul(2).saturating_add(1);
            }
            (hint + last + 1, hint + offset.min(max))
        } else {
            let max = hint + 1;
            while offset < max && !self.less(values[hint - offset], key) {
                last = offset;
                offset = offset.saturating_mul(2).saturating_add(1);
            }
            (max - offset.min(max), hint - last)
        };
        while left < right {
            let middle = left + (right - left) / 2;
            if self.less(values[middle], key) {
                left = middle + 1;
            } else {
                right = middle;
            }
        }
        right
    }
    pub(super) fn gallop_right(&self, key: usize, values: &[usize], hint: usize) -> usize {
        let mut last = 0;
        let mut offset = 1;
        let (mut left, mut right) = if self.less(key, values[hint]) {
            let max = hint + 1;
            while offset < max && self.less(key, values[hint - offset]) {
                last = offset;
                offset = offset.saturating_mul(2).saturating_add(1);
            }
            (max - offset.min(max), hint - last)
        } else {
            let max = values.len() - hint;
            while offset < max && !self.less(key, values[hint + offset]) {
                last = offset;
                offset = offset.saturating_mul(2).saturating_add(1);
            }
            (hint + last + 1, hint + offset.min(max))
        };
        while left < right {
            let middle = left + (right - left) / 2;
            if self.less(key, values[middle]) {
                right = middle;
            } else {
                left = middle + 1;
            }
        }
        right
    }
}
