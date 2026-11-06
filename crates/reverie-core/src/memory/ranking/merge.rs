use super::Sorter;
struct Forward {
    destination: usize,
    left: usize,
    right: usize,
    left_remaining: usize,
    right_remaining: usize,
}
impl Sorter<'_> {
    pub(super) fn merge_lo(&mut self, start: usize, left: usize, right: usize) {
        self.buffer.clear();
        self.buffer
            .extend_from_slice(&self.order[start..start + left]);
        let mut state = Forward {
            destination: start,
            left: 0,
            right: start + left,
            left_remaining: left,
            right_remaining: right,
        };
        self.forward_right(&mut state, 1);
        let mut minimum = self.min_gallop;
        while state.right_remaining > 0 && state.left_remaining > 1 {
            let (a, b) = self.forward_straight(&mut state, minimum);
            if state.right_remaining == 0 || state.left_remaining <= 1 {
                break;
            }
            debug_assert!(a >= minimum || b >= minimum);
            minimum += 1;
            self.forward_gallop(&mut state, &mut minimum);
        }
        if state.left_remaining == 1 && state.right_remaining > 0 {
            let right = state.right_remaining;
            self.forward_right(&mut state, right);
            self.forward_left(&mut state, 1);
        } else {
            let left = state.left_remaining;
            self.forward_left(&mut state, left);
        }
    }
    fn forward_gallop(&mut self, state: &mut Forward, minimum: &mut usize) {
        loop {
            *minimum -= usize::from(*minimum > 1);
            self.min_gallop = *minimum;
            let a = self.gallop_right(
                self.order[state.right],
                &self.buffer[state.left..state.left + state.left_remaining],
                0,
            );
            self.forward_left(state, a);
            if state.left_remaining <= 1 {
                break;
            }
            self.forward_right(state, 1);
            if state.right_remaining == 0 {
                break;
            }
            let b = self.gallop_left(
                self.buffer[state.left],
                &self.order[state.right..state.right + state.right_remaining],
                0,
            );
            self.forward_right(state, b);
            if state.right_remaining == 0 {
                break;
            }
            self.forward_left(state, 1);
            if state.left_remaining <= 1 {
                break;
            }
            if a < 7 && b < 7 {
                *minimum += 1;
                self.min_gallop = *minimum;
                break;
            }
        }
    }
    fn forward_straight(&mut self, state: &mut Forward, minimum: usize) -> (usize, usize) {
        let mut a = 0;
        let mut b = 0;
        while state.left_remaining > 1 && state.right_remaining > 0 {
            if self.less(self.order[state.right], self.buffer[state.left]) {
                self.forward_right(state, 1);
                b += 1;
                a = 0;
            } else {
                self.forward_left(state, 1);
                a += 1;
                b = 0;
            }
            if a >= minimum || b >= minimum {
                break;
            }
        }
        (a, b)
    }
    fn forward_left(&mut self, state: &mut Forward, count: usize) {
        self.order[state.destination..state.destination + count]
            .copy_from_slice(&self.buffer[state.left..state.left + count]);
        state.destination += count;
        state.left += count;
        state.left_remaining -= count;
    }
    fn forward_right(&mut self, state: &mut Forward, count: usize) {
        self.order
            .copy_within(state.right..state.right + count, state.destination);
        state.destination += count;
        state.right += count;
        state.right_remaining -= count;
    }
}
struct Backward {
    destination: usize,
    left_end: usize,
    left_start: usize,
    left_remaining: usize,
    right_remaining: usize,
}
impl Sorter<'_> {
    pub(super) fn merge_hi(&mut self, start: usize, left: usize, right: usize) {
        self.buffer.clear();
        self.buffer
            .extend_from_slice(&self.order[start + left..start + left + right]);
        let mut state = Backward {
            destination: start + left + right,
            left_end: start + left,
            left_start: start,
            left_remaining: left,
            right_remaining: right,
        };
        self.backward_left(&mut state, 1);
        let mut minimum = self.min_gallop;
        while state.left_remaining > 0 && state.right_remaining > 1 {
            let (a, b) = self.backward_straight(&mut state, minimum);
            if state.left_remaining == 0 || state.right_remaining <= 1 {
                break;
            }
            debug_assert!(a >= minimum || b >= minimum);
            minimum += 1;
            self.backward_gallop(&mut state, &mut minimum);
        }
        if state.right_remaining == 1 && state.left_remaining > 0 {
            let left = state.left_remaining;
            self.backward_left(&mut state, left);
            self.backward_right(&mut state, 1);
        } else {
            let right = state.right_remaining;
            self.backward_right(&mut state, right);
        }
    }
    fn backward_gallop(&mut self, state: &mut Backward, minimum: &mut usize) {
        loop {
            *minimum -= usize::from(*minimum > 1);
            self.min_gallop = *minimum;
            let offset = self.gallop_right(
                self.buffer[state.right_remaining - 1],
                &self.order[state.left_start..state.left_end],
                state.left_remaining - 1,
            );
            let a = state.left_remaining - offset;
            self.backward_left(state, a);
            if state.left_remaining == 0 {
                break;
            }
            self.backward_right(state, 1);
            if state.right_remaining <= 1 {
                break;
            }
            let offset = self.gallop_left(
                self.order[state.left_end - 1],
                &self.buffer[..state.right_remaining],
                state.right_remaining - 1,
            );
            let b = state.right_remaining - offset;
            self.backward_right(state, b);
            if state.right_remaining <= 1 {
                break;
            }
            self.backward_left(state, 1);
            if state.left_remaining == 0 {
                break;
            }
            if a < 7 && b < 7 {
                *minimum += 1;
                self.min_gallop = *minimum;
                break;
            }
        }
    }
    fn backward_straight(&mut self, state: &mut Backward, minimum: usize) -> (usize, usize) {
        let mut a = 0;
        let mut b = 0;
        while state.left_remaining > 0 && state.right_remaining > 1 {
            if self.less(
                self.buffer[state.right_remaining - 1],
                self.order[state.left_end - 1],
            ) {
                self.backward_left(state, 1);
                a += 1;
                b = 0;
            } else {
                self.backward_right(state, 1);
                b += 1;
                a = 0;
            }
            if a >= minimum || b >= minimum {
                break;
            }
        }
        (a, b)
    }
    fn backward_left(&mut self, state: &mut Backward, count: usize) {
        self.order.copy_within(
            state.left_end - count..state.left_end,
            state.destination - count,
        );
        state.destination -= count;
        state.left_end -= count;
        state.left_remaining -= count;
    }
    fn backward_right(&mut self, state: &mut Backward, count: usize) {
        self.order[state.destination - count..state.destination]
            .copy_from_slice(&self.buffer[state.right_remaining - count..state.right_remaining]);
        state.destination -= count;
        state.right_remaining -= count;
    }
}
