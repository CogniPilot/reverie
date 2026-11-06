use super::*;
use std::sync::{Arc, Barrier};

#[test]
fn concurrent_same_revision_has_exactly_one_commit() {
    let tree = Tree::new();
    let barrier = Arc::new(Barrier::new(2));
    let mut threads = Vec::new();
    for _ in 0..2 {
        let path = tree.root.clone();
        let barrier = barrier.clone();
        threads.push(std::thread::spawn(move || {
            let store = ProfileStore::open(path).unwrap();
            barrier.wait();
            store.put(&new_intent()).is_ok()
        }));
    }
    assert_eq!(
        threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .filter(|committed| *committed)
            .count(),
        1
    );
    assert_eq!(tree.open().snapshot().unwrap().revision().get(), 1);
}
