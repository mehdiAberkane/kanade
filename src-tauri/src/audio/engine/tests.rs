use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use super::*;

/// What the fake output holds: the paths queued, where the first is.
#[derive(Debug, Default)]
struct Sound {
    queued: Vec<PathBuf>,
    position: Duration,
    paused: bool,
    volume: f32,
    /// Paths that do not decode.
    broken: Vec<PathBuf>,
    /// Sinks opened.
    sinks: usize,
    no_output: bool,
}

#[derive(Clone, Default)]
pub(crate) struct Fake(Arc<Mutex<Sound>>);

/// A sink of the fake output: dropped, its queue goes.
pub(crate) struct FakeSink(Fake);

impl Drop for FakeSink {
    fn drop(&mut self) {
        let mut sound = self.0.sound();
        sound.queued.clear();
        sound.position = Duration::ZERO;
    }
}

impl Fake {
    fn sound(&self) -> std::sync::MutexGuard<'_, Sound> {
        self.0.lock().unwrap()
    }

    /// The track playing ends.
    pub(crate) fn finish(&self) {
        let mut sound = self.sound();
        sound.queued.remove(0);
        sound.position = Duration::ZERO;
    }

    fn at(&self, ms: u64) {
        self.sound().position = Duration::from_millis(ms);
    }

    fn len(&self) -> usize {
        self.sound().queued.len()
    }

    fn position(&self) -> Duration {
        self.sound().position
    }

    /// The file names queued in the sink.
    pub(crate) fn queued(&self) -> Vec<String> {
        self.sound()
            .queued
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect()
    }
}

impl Output for Fake {
    type Sink = FakeSink;
    fn sink(&mut self) -> Result<FakeSink, AudioError> {
        let mut sound = self.sound();
        if sound.no_output {
            return Err(AudioError::NoOutput {
                message: "no device".into(),
            });
        }
        sound.sinks += 1;
        drop(sound);
        Ok(FakeSink(self.clone()))
    }
}

impl Sink for FakeSink {
    fn append(&mut self, path: &Path) -> Result<(), AudioError> {
        let mut sound = self.0.sound();
        if sound.broken.iter().any(|b| b == path) {
            return Err(AudioError::Unreadable {
                message: "bad data".into(),
            });
        }
        sound.queued.push(path.to_path_buf());
        Ok(())
    }
    fn play(&self) {
        self.0.sound().paused = false;
    }
    fn pause(&self) {
        self.0.sound().paused = true;
    }
    fn seek(&self, to: Duration) -> Result<(), AudioError> {
        self.0.sound().position = to;
        Ok(())
    }
    fn position(&self) -> Duration {
        self.0.position()
    }
    fn len(&self) -> usize {
        self.0.len()
    }
    fn set_volume(&self, volume: f32) {
        self.0.sound().volume = volume;
    }
}

/// Tracks 1 to 9, three minutes each; some gone or in a format not read.
#[derive(Clone, Default)]
pub(crate) struct Shelf {
    skip: HashMap<i64, Skip>,
    kept: Arc<Mutex<Option<Memory>>>,
}

impl Library for Shelf {
    fn playable(&self, id: TrackId) -> Option<Playable> {
        (1..=9).contains(&id.0).then(|| Playable {
            path: PathBuf::from(format!("{}.flac", id.0)),
            id,
            title: format!("Track {}", id.0),
            artist: Some("Artist".into()),
            album: None,
            duration_ms: Some(180_000),
            has_cover: false,
            skip: self.skip.get(&id.0).copied(),
        })
    }
    fn remember(&self, memory: &Memory) {
        *self.kept.lock().unwrap() = Some(memory.clone());
    }
    fn recall(&self) -> Option<Memory> {
        self.kept.lock().unwrap().clone()
    }
}

fn ids(list: &[i64]) -> Vec<TrackId> {
    list.iter().copied().map(TrackId).collect()
}

fn engine(shelf: Shelf) -> (Engine<Fake, Shelf>, Fake) {
    let fake = Fake::default();
    (Engine::new(fake.clone(), shelf, 1), fake)
}

fn current(e: &Engine<Fake, Shelf>) -> Option<i64> {
    e.state().current.map(|c| c.id.0)
}

#[test]
fn plays_a_track_then_the_next_without_a_gap() {
    let (mut e, out) = engine(Shelf::default());
    assert_eq!(e.state().current, None);
    e.play(ids(&[1, 2, 3]), 1);
    assert_eq!(current(&e), Some(2));
    assert!(e.playing());
    assert_eq!(out.queued(), ["2.flac"]);
    assert!(!out.sound().paused);

    // Far from the end: nothing added. Near it: the next one follows.
    out.at(60_000);
    assert!(!e.tick());
    assert_eq!(out.queued(), ["2.flac"]);
    out.at(176_000);
    assert!(!e.tick());
    assert_eq!(out.queued(), ["2.flac", "3.flac"]);
    // Added once only.
    e.tick();
    assert_eq!(out.len(), 2);

    out.finish();
    assert!(e.tick());
    assert_eq!(current(&e), Some(3));
    assert_eq!(out.queued(), ["3.flac"]);
    assert_eq!(e.state().at, Some(2));

    // The end of the queue: paused at the start of the last track.
    out.finish();
    assert!(e.tick());
    assert!(!e.playing());
    assert_eq!(current(&e), Some(3));
    assert_eq!(e.position(), Duration::ZERO);
    // Play again: the last track from its start.
    e.toggle();
    assert!(e.playing());
    assert_eq!(out.queued(), ["3.flac"]);
}

#[test]
fn repeats_one_track_or_the_whole_queue() {
    let (mut e, out) = engine(Shelf::default());
    e.set_repeat(Repeat::One);
    e.play(ids(&[1, 2]), 0);
    out.at(178_000);
    e.tick();
    assert_eq!(out.queued(), ["1.flac", "1.flac"]);
    out.finish();
    e.tick();
    assert_eq!(current(&e), Some(1));

    e.set_repeat(Repeat::All);
    // The track added no longer comes next: dropped, the current one kept.
    e.next();
    assert_eq!(current(&e), Some(2));
    out.at(178_000);
    e.tick();
    assert_eq!(out.queued(), ["2.flac", "1.flac"]);
    out.finish();
    e.tick();
    assert_eq!(current(&e), Some(1));
}

#[test]
fn goes_back_to_the_start_or_to_the_track_before() {
    let (mut e, out) = engine(Shelf::default());
    e.play(ids(&[1, 2, 3]), 1);
    out.at(10_000);
    e.previous();
    assert_eq!(current(&e), Some(2));
    assert_eq!(out.position(), Duration::ZERO);
    e.previous();
    assert_eq!(current(&e), Some(1));
    e.jump(2);
    assert_eq!(current(&e), Some(3));
    e.jump(9);
    assert_eq!(current(&e), Some(3));
    e.next();
    assert!(!e.playing(), "the end of the queue");
}

#[test]
fn pauses_seeks_and_sets_the_volume() {
    let (mut e, out) = engine(Shelf::default());
    e.set_volume(0.5);
    e.play(ids(&[1]), 0);
    assert_eq!(out.sound().volume, 0.5);
    e.toggle();
    assert!(out.sound().paused);
    assert!(!e.playing());
    e.toggle();
    assert!(!out.sound().paused);
    e.seek(Duration::from_secs(90));
    assert_eq!(e.state().position_ms, 90_000);
    e.set_muted(true);
    assert_eq!(out.sound().volume, 0.0);
    e.set_volume(3.0);
    assert_eq!(e.state().volume, 1.0);
    e.set_muted(false);
    assert_eq!(out.sound().volume, 1.0);
    // Paused, nothing changes when it ticks.
    e.pause();
    assert!(!e.tick());

    // A seek near the end drops the track added after it.
    let (mut e, out) = engine(Shelf::default());
    e.play(ids(&[1, 2]), 0);
    out.at(179_000);
    e.tick();
    assert_eq!(out.len(), 2);
    e.seek(Duration::from_secs(10));
    assert_eq!(out.queued(), ["1.flac"]);
    assert_eq!(e.position(), Duration::from_secs(10));
    assert!(e.playing());
}

#[test]
fn skips_what_cannot_be_played_and_stops_after_several() {
    let shelf = Shelf {
        skip: [(2, Skip::Gone), (3, Skip::Format)].into(),
        ..Shelf::default()
    };
    let (mut e, out) = engine(shelf);
    out.sound().broken.push(PathBuf::from("4.flac"));
    e.play(ids(&[2, 5]), 0);
    assert_eq!(current(&e), Some(5));
    assert_eq!(
        e.state().notice,
        Some(Notice::Skipped {
            title: "Track 2".into(),
            reason: SkipReason::Gone
        })
    );
    // Gone from the index: skipped too.
    e.play(ids(&[42, 1]), 0);
    assert_eq!(current(&e), Some(1));

    e.play(ids(&[2, 3, 4, 1]), 0);
    assert!(!e.playing());
    assert_eq!(e.state().notice, Some(Notice::Stopped));

    // A track not read added after the current one: not added, skipped at its turn.
    e.play(ids(&[1, 4, 5]), 0);
    out.at(178_000);
    e.tick();
    assert_eq!(out.queued(), ["1.flac"]);
    out.finish();
    e.tick();
    assert_eq!(current(&e), Some(5));
    assert_eq!(
        e.state().notice,
        Some(Notice::Skipped {
            title: "Track 4".into(),
            reason: SkipReason::Unreadable
        })
    );
    // Nothing left to play in the queue after a skip at its end.
    e.play(ids(&[1, 3]), 1);
    assert!(!e.playing());
}

#[test]
fn says_when_there_is_no_output() {
    let (mut e, out) = engine(Shelf::default());
    out.sound().no_output = true;
    e.play(ids(&[1, 2]), 0);
    assert!(!e.playing());
    assert_eq!(
        e.state().notice,
        Some(Notice::NoOutput {
            message: "no device".into()
        })
    );
    // Nothing loaded: a tick does nothing.
    assert!(!e.tick());
}

#[test]
fn the_queue_changes_while_it_plays() {
    let (mut e, out) = engine(Shelf::default());
    e.play(ids(&[1, 2, 3]), 0);
    e.enqueue(&ids(&[7]), true);
    e.enqueue(&ids(&[8]), false);
    assert_eq!(e.state().queue, ids(&[1, 7, 2, 3, 8]));
    out.at(178_000);
    e.tick();
    assert_eq!(out.queued(), ["1.flac", "7.flac"]);
    // Moved away from next: the track added is dropped, the current one goes on.
    e.move_track(1, 4);
    assert_eq!(out.queued(), ["1.flac"]);
    assert_eq!(out.position(), Duration::from_millis(178_000));
    assert!(e.playing());

    // The current track removed while it plays: the next one plays.
    e.remove(0);
    assert_eq!(current(&e), Some(2));
    assert!(e.playing());
    e.remove(3);
    assert_eq!(e.state().queue, ids(&[2, 3, 8]));

    // Paused, it stays paused on the next one.
    e.pause();
    e.remove(0);
    assert_eq!(current(&e), Some(3));
    assert!(!e.playing());
    e.toggle();
    assert_eq!(out.queued(), ["3.flac"]);

    e.set_shuffle(true);
    assert!(e.state().shuffle);
    assert_eq!(current(&e), Some(3));
    // The last one removed: nothing current.
    e.set_shuffle(false);
    e.jump(1);
    e.remove(1);
    assert_eq!(e.state().current, None);
    assert!(!e.playing());

    e.play(ids(&[1, 2]), 0);
    e.clear();
    assert_eq!((e.state().queue.len(), e.state().current), (0, None));
    assert!(out.queued().is_empty());
}

#[test]
fn starts_again_where_it_was_left_paused() {
    let shelf = Shelf::default();
    let (mut e, out) = engine(shelf.clone());
    e.set_volume(0.3);
    e.set_repeat(Repeat::All);
    e.play(ids(&[4, 5, 6]), 1);
    out.at(42_000);
    e.remember();

    let (mut again, out) = engine(shelf);
    let state = again.state();
    assert_eq!(state.current.map(|c| c.id), Some(TrackId(5)));
    assert!(!state.playing);
    assert_eq!(state.position_ms, 42_000);
    assert_eq!((state.volume, state.repeat), (0.3, Repeat::All));
    // Nothing opened until it plays; then from where it was.
    assert_eq!(out.sound().sinks, 0);
    again.toggle();
    assert_eq!(out.queued(), ["5.flac"]);
    assert_eq!(out.position(), Duration::from_millis(42_000));
    // A seek before it plays: kept for when it does.
    let (mut paused, _) = engine(Shelf::default());
    paused.seek(Duration::from_secs(5));
    assert_eq!(paused.position(), Duration::from_secs(5));
    // Nothing in the queue: playing does nothing.
    paused.toggle();
    assert!(!paused.playing());
    paused.previous();
    assert_eq!(paused.position(), Duration::ZERO);
}
