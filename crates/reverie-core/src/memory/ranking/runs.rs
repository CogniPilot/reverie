use super::Sorter;
impl Sorter<'_> {
    pub(super) fn count_run(&mut self, start: usize) -> usize {
        let remaining = self.order.len() - start;
        let mut n = 1;
        while n < remaining && !self.less(self.order[start + n], self.order[start + n - 1]) {
            n += 1;
        }
        if n == remaining {
            return n;
        }
        if n > 1 {
            if self.less(self.order[start], self.order[start + n - 1]) {
                return n;
            }
            self.order[start..start + n].reverse();
        }
        n += 1;
        let mut equal = 0;
        while n < remaining {
            if self.less(self.order[start + n], self.order[start + n - 1]) {
                self.reverse_equal(start, n, &mut equal);
            } else if self.less(self.order[start + n - 1], self.order[start + n]) {
                break;
            } else {
                equal += 1;
            }
            n += 1;
        }
        self.reverse_equal(start, n, &mut equal);
        self.order[start..start + n].reverse();
        while n < remaining && !self.less(self.order[start + n], self.order[start + n - 1]) {
            n += 1;
        }
        n
    }
    fn reverse_equal(&mut self, start: usize, n: usize, equal: &mut usize) {
        if *equal > 0 {
            self.order[start + n - *equal - 1..start + n].reverse();
            *equal = 0;
        }
    }
    pub(super) fn binary_sort(&mut self, start: usize, length: usize, sorted: usize) {
        for next in sorted.max(1)..length {
            let pivot = self.order[start + next];
            let left = self.insertion_position(start, next, pivot);
            self.order
                .copy_within(start + left..start + next, start + left + 1);
            self.order[start + left] = pivot;
        }
    }
    fn insertion_position(&self, start: usize, next: usize, pivot: usize) -> usize {
        let mut left = 0;
        let mut right = next;
        while left < right {
            let middle = left + (right - left) / 2;
            if self.less(pivot, self.order[start + middle]) {
                right = middle;
            } else {
                left = middle + 1;
            }
        }
        left
    }
}
pub(super) fn minrun(mut length: usize) -> usize {
    let mut remainder = 0;
    while length >= 64 {
        remainder |= length & 1;
        length >>= 1;
    }
    length + remainder
}
pub(super) fn power(start: usize, first: usize, second: usize, total: usize) -> usize {
    // Doubled midpoints fit u128 for every physically possible Rust slice.
    let total = total as u128;
    let mut a = 2 * start as u128 + first as u128;
    let mut b = a + first as u128 + second as u128;
    let mut result = 0;
    loop {
        result += 1;
        if a >= total {
            a -= total;
            b -= total;
        } else if b >= total {
            return result;
        }
        a *= 2;
        b *= 2;
    }
}
