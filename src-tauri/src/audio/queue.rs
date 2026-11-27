//! The queue of the built-in player (KAN-8): the tracks to play, by their
//! stable id, the one playing, and the order they play in. Shuffled, every
//! track plays once before any plays again. Pure logic: the engine asks it
//! what comes next.

use serde::{Deserialize, Serialize};

use crate::library::TrackId;

/// What happens at the end of a track.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Repeat {
    /// The queue plays once.
    #[default]
    Off,
    /// The queue starts again (shuffled anew).
    All,
    /// The track plays again; « suivant » still goes on.
    One,
}

/// A small random source (xorshift): shuffling a queue needs no more.
#[derive(Debug, Clone)]
pub struct Shuffler(u64);

impl Shuffler {
    pub fn new(seed: u64) -> Self {
        Self(seed | 1)
    }

    fn below(&mut self, n: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        // n is a queue's length: far below u64::MAX.
        usize::try_from(self.0 % u64::try_from(n).unwrap_or(u64::MAX)).unwrap_or(0)
    }

    /// Fisher–Yates.
    fn shuffle<T>(&mut self, items: &mut [T]) {
        for i in (1..items.len()).rev() {
            items.swap(i, self.below(i + 1));
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    /// The tracks, in the order the queue shows them.
    tracks: Vec<TrackId>,
    /// The order they play in: positions in `tracks`.
    order: Vec<usize>,
    /// Where in `order` the track playing is.
    at: Option<usize>,
    shuffle: bool,
}

impl Queue {
    pub fn tracks(&self) -> &[TrackId] {
        &self.tracks
    }

    pub fn shuffled(&self) -> bool {
        self.shuffle
    }

    /// The track playing (or paused), if any.
    pub fn current(&self) -> Option<TrackId> {
        self.at.map(|at| self.tracks[self.order[at]])
    }

    /// Where the track playing is in `tracks()`.
    pub fn position(&self) -> Option<usize> {
        self.at.map(|at| self.order[at])
    }

    /// A queue read back from the settings that does not hold together
    /// (another version, a hand edit): empty instead.
    pub fn checked(self) -> Self {
        let n = self.tracks.len();
        let mut seen = vec![false; n];
        let whole = self.order.len() == n
            && self
                .order
                .iter()
                .all(|&p| p < n && !std::mem::replace(&mut seen[p], true))
            && self.at.is_none_or(|at| at < n);
        if whole { self } else { Self::default() }
    }

    /// `ids` instead of the queue, `start` the one to play. Shuffled, it
    /// plays first and the others follow in a random order.
    pub fn replace(&mut self, ids: Vec<TrackId>, start: usize, rng: &mut Shuffler) {
        self.tracks = ids;
        self.at = (start < self.tracks.len()).then_some(0);
        self.reorder(start, rng);
    }

    /// The play order anew: `first` first, the rest in order or shuffled.
    fn reorder(&mut self, first: usize, rng: &mut Shuffler) {
        let n = self.tracks.len();
        if self.shuffle && first < n {
            let mut rest: Vec<usize> = (0..n).filter(|&p| p != first).collect();
            rng.shuffle(&mut rest);
            self.order = std::iter::once(first).chain(rest).collect();
            self.at = self.at.map(|_| 0);
        } else {
            self.order = (0..n).collect();
            self.at = self.at.map(|_| first);
        }
    }

    /// Shuffles the queue from the track playing on, or puts it back in order.
    pub fn set_shuffle(&mut self, shuffle: bool, rng: &mut Shuffler) {
        self.shuffle = shuffle;
        let first = self.position().unwrap_or(0);
        self.reorder(first, rng);
    }

    /// `ids` right after the track playing: they play next, in this order.
    pub fn play_next(&mut self, ids: &[TrackId]) {
        let Some(at) = self.at else {
            self.append(ids);
            return;
        };
        let insert = self.order[at] + 1;
        let added = ids.len();
        self.tracks.splice(insert..insert, ids.iter().copied());
        for p in &mut self.order {
            if *p >= insert {
                *p += added;
            }
        }
        self.order.splice(at + 1..at + 1, insert..insert + added);
    }

    /// `ids` at the end: they play last.
    pub fn append(&mut self, ids: &[TrackId]) {
        let start = self.tracks.len();
        self.tracks.extend_from_slice(ids);
        self.order.extend(start..self.tracks.len());
    }

    /// Removes the track at `position`. When it was the one playing, the
    /// one after it becomes current (none at the end); true then.
    pub fn remove(&mut self, position: usize) -> bool {
        if position >= self.tracks.len() {
            return false;
        }
        let was_current = self.position() == Some(position);
        let index = self.order.iter().position(|&p| p == position).unwrap_or(0);
        self.tracks.remove(position);
        self.order.remove(index);
        for p in &mut self.order {
            if *p > position {
                *p -= 1;
            }
        }
        if let Some(at) = self.at {
            if index < at {
                self.at = Some(at - 1);
            } else if was_current && at >= self.order.len() {
                self.at = None;
            }
        }
        was_current
    }

    /// Moves the track at `from` to `to`, in the queue's order. The play
    /// order follows it when not shuffled.
    pub fn move_track(&mut self, from: usize, to: usize) {
        let n = self.tracks.len();
        if from >= n || to >= n || from == to {
            return;
        }
        let current = self.position();
        let id = self.tracks.remove(from);
        self.tracks.insert(to, id);
        // Where each old position went.
        let moved = |p: usize| {
            if p == from {
                to
            } else if from < to && p > from && p <= to {
                p - 1
            } else if to < from && p >= to && p < from {
                p + 1
            } else {
                p
            }
        };
        if self.shuffle {
            for p in &mut self.order {
                *p = moved(*p);
            }
        } else {
            self.order = (0..n).collect();
            self.at = current.map(moved);
        }
    }

    pub fn clear(&mut self) {
        self.tracks.clear();
        self.order.clear();
        self.at = None;
    }

    /// The track at `position` becomes the one playing.
    pub fn jump(&mut self, position: usize) -> Option<TrackId> {
        self.at = Some(self.order.iter().position(|&p| p == position)?);
        self.current()
    }

    /// What plays once the current track ends, without moving: for the
    /// next track to follow it without a gap. None when it is not known yet
    /// (the queue reshuffled at its end).
    pub fn upcoming(&self, repeat: Repeat) -> Option<TrackId> {
        let at = self.at?;
        match repeat {
            Repeat::One => self.current(),
            _ if at + 1 < self.order.len() => Some(self.tracks[self.order[at + 1]]),
            Repeat::All if !self.shuffle => self.tracks.first().copied(),
            _ => None,
        }
    }

    /// Goes on to the next track: at the end of one (`by_user` false), or on
    /// « suivant ». None at the end of the queue, which then stays on its
    /// last track.
    pub fn advance(
        &mut self,
        repeat: Repeat,
        by_user: bool,
        rng: &mut Shuffler,
    ) -> Option<TrackId> {
        let at = self.at?;
        if repeat == Repeat::One && !by_user {
            return self.current();
        }
        if at + 1 < self.order.len() {
            self.at = Some(at + 1);
        } else if repeat == Repeat::Off {
            return None;
        } else {
            // Round again: shuffled anew, without the last one first.
            if self.shuffle {
                let last = self.order[at];
                let mut rest: Vec<usize> = (0..self.tracks.len()).filter(|&p| p != last).collect();
                rng.shuffle(&mut rest);
                rest.push(last);
                self.order = rest;
            }
            self.at = Some(0);
        }
        self.current()
    }

    /// Back one track; at the first, the last one when the queue repeats,
    /// else the first again.
    pub fn back(&mut self, repeat: Repeat) -> Option<TrackId> {
        let at = self.at?;
        self.at = Some(if at > 0 {
            at - 1
        } else if repeat == Repeat::All {
            self.order.len() - 1
        } else {
            0
        });
        self.current()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(n: i64) -> Vec<TrackId> {
        (1..=n).map(TrackId).collect()
    }

    fn queue(n: i64, start: usize) -> Queue {
        let mut q = Queue::default();
        q.replace(ids(n), start, &mut Shuffler::new(7));
        q
    }

    /// The tracks in the order they play, from the current one.
    fn plays(q: &mut Queue, repeat: Repeat, count: usize) -> Vec<i64> {
        let mut rng = Shuffler::new(3);
        let mut out = vec![q.current().unwrap().0];
        for _ in 1..count {
            match q.advance(repeat, false, &mut rng) {
                Some(id) => out.push(id.0),
                None => break,
            }
        }
        out
    }

    #[test]
    fn plays_from_the_track_chosen_to_the_end_or_round_again() {
        let mut q = queue(4, 1);
        assert_eq!(q.current(), Some(TrackId(2)));
        assert_eq!(q.upcoming(Repeat::Off), Some(TrackId(3)));
        assert_eq!(plays(&mut q, Repeat::Off, 10), [2, 3, 4]);
        // The end: it stays on the last one.
        assert_eq!(q.current(), Some(TrackId(4)));
        assert_eq!(q.upcoming(Repeat::Off), None);
        assert_eq!(q.upcoming(Repeat::All), Some(TrackId(1)));
        assert_eq!(plays(&mut q, Repeat::All, 3), [4, 1, 2]);
        // One track again, unless « suivant ».
        assert_eq!(plays(&mut q, Repeat::One, 3), [2, 2, 2]);
        assert_eq!(q.upcoming(Repeat::One), Some(TrackId(2)));
        let mut rng = Shuffler::new(1);
        assert_eq!(q.advance(Repeat::One, true, &mut rng), Some(TrackId(3)));
        assert_eq!(q.back(Repeat::Off), Some(TrackId(2)));
        q.jump(0);
        assert_eq!(q.back(Repeat::Off), Some(TrackId(1)));
        assert_eq!(q.back(Repeat::All), Some(TrackId(4)));
        assert_eq!(q.jump(9), None);
    }

    #[test]
    fn shuffled_every_track_plays_once_before_any_again() {
        let mut q = queue(10, 3);
        let mut rng = Shuffler::new(42);
        q.set_shuffle(true, &mut rng);
        assert!(q.shuffled());
        assert_eq!(q.current(), Some(TrackId(4)));
        let round = plays(&mut q, Repeat::All, 10);
        let mut sorted = round.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, (1..=10).collect::<Vec<_>>());
        assert_ne!(round, [4, 5, 6, 7, 8, 9, 10, 1, 2, 3]);
        // Not known before the round ends, then a new round of all.
        assert_eq!(q.upcoming(Repeat::All), None);
        let last = q.current().unwrap();
        let next = plays(&mut q, Repeat::All, 11);
        assert_ne!(next[1], last.0, "the last one does not start the round");
        let mut again = next[1..].to_vec();
        again.sort_unstable();
        assert_eq!(again, (1..=10).collect::<Vec<_>>());
        // Back in order, from the track playing.
        let playing = q.position().unwrap();
        q.set_shuffle(false, &mut rng);
        assert_eq!(q.position(), Some(playing));
        assert_eq!(
            q.upcoming(Repeat::Off),
            q.tracks().get(playing + 1).copied()
        );
    }

    #[test]
    fn adds_tracks_to_play_next_or_last() {
        let mut q = queue(3, 0);
        q.play_next(&[TrackId(8), TrackId(9)]);
        q.append(&[TrackId(7)]);
        assert_eq!(q.tracks(), &[1, 8, 9, 2, 3, 7].map(TrackId));
        assert_eq!(plays(&mut q, Repeat::Off, 10), [1, 8, 9, 2, 3, 7]);

        // Shuffled: still next, then the rest of the round.
        let mut q = queue(4, 0);
        q.set_shuffle(true, &mut Shuffler::new(5));
        q.play_next(&[TrackId(9)]);
        assert_eq!(q.upcoming(Repeat::Off), Some(TrackId(9)));

        // Nothing playing: added at the end, nothing current.
        let mut empty = Queue::default();
        empty.play_next(&[TrackId(1)]);
        assert_eq!((empty.tracks(), empty.current()), (&[TrackId(1)][..], None));
        assert_eq!(
            empty.advance(Repeat::All, true, &mut Shuffler::new(1)),
            None
        );
        assert_eq!(empty.back(Repeat::All), None);
        assert_eq!(empty.upcoming(Repeat::All), None);
        empty.replace(vec![], 0, &mut Shuffler::new(1));
        assert_eq!(empty.current(), None);
    }

    #[test]
    fn removes_and_moves_tracks_the_current_one_followed() {
        let mut q = queue(5, 2);
        // Before the current one: it stays current.
        assert!(!q.remove(0));
        assert_eq!(q.current(), Some(TrackId(3)));
        // The current one: the next becomes current.
        assert!(q.remove(1));
        assert_eq!(q.current(), Some(TrackId(4)));
        assert!(!q.remove(9));
        // The last one, current: none left after it.
        q.jump(2);
        assert!(q.remove(2));
        assert_eq!(q.current(), None);
        assert_eq!(q.tracks(), &[TrackId(2), TrackId(4)]);

        let mut q = queue(5, 1);
        q.move_track(1, 4);
        assert_eq!(q.tracks(), &[1, 3, 4, 5, 2].map(TrackId));
        assert_eq!(q.current(), Some(TrackId(2)));
        assert_eq!(q.upcoming(Repeat::Off), None);
        q.move_track(4, 0);
        assert_eq!(q.tracks(), &[2, 1, 3, 4, 5].map(TrackId));
        assert_eq!(q.upcoming(Repeat::Off), Some(TrackId(1)));
        q.move_track(0, 0);
        q.move_track(0, 9);
        assert_eq!(q.position(), Some(0));

        // Shuffled: the play order keeps the same tracks.
        let mut q = queue(5, 0);
        q.set_shuffle(true, &mut Shuffler::new(9));
        let before = plays(&mut q.clone(), Repeat::Off, 5);
        q.move_track(4, 1);
        assert_eq!(plays(&mut q, Repeat::Off, 5), before);

        q.clear();
        assert_eq!((q.tracks().len(), q.current()), (0, None));
    }

    #[test]
    fn a_queue_read_back_that_does_not_hold_together_is_dropped() {
        let q = queue(3, 1);
        assert_eq!(q.clone().checked(), q);
        let json = serde_json::to_value(&q).unwrap();
        assert_eq!(json["tracks"], serde_json::json!([1, 2, 3]));
        for broken in [
            serde_json::json!({ "tracks": [1, 2], "order": [0, 0], "at": 0, "shuffle": false }),
            serde_json::json!({ "tracks": [1, 2], "order": [0, 1], "at": 5, "shuffle": false }),
            serde_json::json!({ "tracks": [1], "order": [0, 1], "at": null, "shuffle": false }),
            serde_json::json!({ "tracks": [1], "order": [3], "at": null, "shuffle": false }),
        ] {
            let read: Queue = serde_json::from_value(broken).unwrap();
            assert_eq!(read.checked(), Queue::default());
        }
    }
}
