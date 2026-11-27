//! The built-in player's engine (KAN-8): it plays the queue's tracks one
//! after the other on an output, the next one added a few seconds before
//! the end of the current one so that they follow without a gap. The
//! output (Windows' sound, or a fake in the tests) and the library (where a
//! track's file is, what to show of it) come from outside.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::queue::{Queue, Repeat, Shuffler};
use crate::library::TrackId;

/// The next track is added this long before the end of the current one.
pub const PRELOAD: Duration = Duration::from_secs(5);
/// « Précédent » past this point starts the track again.
pub const RESTART_AFTER: Duration = Duration::from_secs(3);
/// Tracks that cannot be played, one after the other, before the player stops
/// instead of going through the whole queue.
pub const MAX_FAILURES: usize = 3;

/// Why a sound did not come out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AudioError {
    /// No output to play on (no sound card, or Windows refused it).
    NoOutput { message: String },
    /// The file could not be decoded.
    Unreadable { message: String },
}

/// Where the sound goes: Windows' default output, or a fake.
pub trait Output: Send {
    type Sink: Sink;
    /// A new sink on the output.
    fn sink(&mut self) -> Result<Self::Sink, AudioError>;
}

/// A queue of decoded tracks that plays on the output; dropped, it stops at
/// once (emptying it in place would wait for the output).
pub trait Sink: Send {
    /// Decodes `path` and queues it after the tracks already queued.
    fn append(&mut self, path: &std::path::Path) -> Result<(), AudioError>;
    fn play(&self);
    fn pause(&self);
    /// Seeks in the track playing.
    fn seek(&self, to: Duration) -> Result<(), AudioError>;
    /// Where the track playing is.
    fn position(&self) -> Duration;
    /// How many tracks are queued, the one playing included.
    fn len(&self) -> usize;
    fn set_volume(&self, volume: f32);
}

/// A track as the player needs it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playable {
    #[serde(skip)]
    pub path: PathBuf,
    pub id: TrackId,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<u64>,
    pub has_cover: bool,
    /// Why the player cannot play it, if it cannot: its file is gone, or its
    /// format is one the decoder does not read.
    #[serde(skip)]
    pub skip: Option<Skip>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Skip {
    Gone,
    Format,
}

/// What the player keeps between two launches, in the settings.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Memory {
    pub queue: Queue,
    pub position_ms: u64,
    pub volume: f32,
    pub muted: bool,
    pub repeat: Repeat,
}

/// Where the player finds the tracks, and keeps what it remembers.
pub trait Library: Send {
    /// The track `id`; None when it left the index.
    fn playable(&self, id: TrackId) -> Option<Playable>;
    fn remember(&self, memory: &Memory);
    fn recall(&self) -> Option<Memory>;
}

/// What the last problem was, for the player's bar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Notice {
    /// A track was skipped: gone, a format not read, or not decoded.
    Skipped {
        title: String,
        reason: SkipReason,
    },
    /// Several tracks in a row could not be played: the player stopped.
    Stopped,
    NoOutput {
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    Gone,
    Format,
    Unreadable,
}

/// The player as the interface shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub current: Option<Playable>,
    pub playing: bool,
    pub position_ms: u64,
    pub volume: f32,
    pub muted: bool,
    pub repeat: Repeat,
    pub shuffle: bool,
    /// The queue, by id, in its order; `at` the one playing.
    pub queue: Vec<TrackId>,
    pub at: Option<usize>,
    pub notice: Option<Notice>,
}

pub struct Engine<O: Output, L: Library> {
    output: O,
    library: L,
    sink: Option<O::Sink>,
    /// The tracks in the sink, in order: the current one, then the one
    /// added to follow it.
    loaded: Vec<TrackId>,
    /// The track playing or paused, as shown.
    current: Option<Playable>,
    queue: Queue,
    rng: Shuffler,
    playing: bool,
    volume: f32,
    muted: bool,
    repeat: Repeat,
    /// Where the current track starts once loaded (kept from the last
    /// launch, or a seek before it was loaded).
    start_at: Duration,
    failures: usize,
    notice: Option<Notice>,
}

impl<O: Output, L: Library> Engine<O, L> {
    /// The player as it was left, paused; `seed` shuffles.
    pub fn new(output: O, library: L, seed: u64) -> Self {
        let memory = library.recall().unwrap_or(Memory {
            volume: 1.0,
            ..Memory::default()
        });
        let mut engine = Self {
            output,
            library,
            sink: None,
            loaded: Vec::new(),
            current: None,
            queue: memory.queue.checked(),
            rng: Shuffler::new(seed),
            playing: false,
            volume: memory.volume.clamp(0.0, 1.0),
            muted: memory.muted,
            repeat: memory.repeat,
            start_at: Duration::from_millis(memory.position_ms),
            failures: 0,
            notice: None,
        };
        engine.current = engine
            .queue
            .current()
            .and_then(|id| engine.library.playable(id));
        engine
    }

    pub fn state(&self) -> PlayerState {
        PlayerState {
            current: self.current.clone(),
            playing: self.playing,
            position_ms: duration_ms(self.position()),
            volume: self.volume,
            muted: self.muted,
            repeat: self.repeat,
            shuffle: self.queue.shuffled(),
            queue: self.queue.tracks().to_vec(),
            at: self.queue.position(),
            notice: self.notice.clone(),
        }
    }

    /// Where the current track is.
    pub fn position(&self) -> Duration {
        match &self.sink {
            Some(sink) if !self.loaded.is_empty() => sink.position(),
            _ => self.start_at,
        }
    }

    pub fn playing(&self) -> bool {
        self.playing
    }

    /// What is kept for the next launch.
    pub fn memory(&self) -> Memory {
        Memory {
            queue: self.queue.clone(),
            position_ms: duration_ms(self.position()),
            volume: self.volume,
            muted: self.muted,
            repeat: self.repeat,
        }
    }

    /// Plays `ids`, from the one at `start`, instead of the queue.
    pub fn play(&mut self, ids: Vec<TrackId>, start: usize) {
        self.queue.replace(ids, start, &mut self.rng);
        self.failures = 0;
        self.start_current(Duration::ZERO);
    }

    /// `ids` played after the current track, or at the end of the queue.
    pub fn enqueue(&mut self, ids: &[TrackId], next: bool) {
        if next {
            self.queue.play_next(ids);
        } else {
            self.queue.append(ids);
        }
        self.follow_queue();
    }

    pub fn toggle(&mut self) {
        if self.playing {
            self.pause();
        } else {
            self.resume();
        }
    }

    pub fn pause(&mut self) {
        if let Some(sink) = &self.sink {
            sink.pause();
        }
        self.playing = false;
    }

    /// Plays on from where it is; the current track loaded if it is not.
    pub fn resume(&mut self) {
        if self.loaded.is_empty() {
            let at = self.start_at;
            self.start_current(at);
        } else if let Some(sink) = &self.sink {
            sink.play();
            self.playing = true;
        }
    }

    /// « Suivant ».
    pub fn next(&mut self) {
        let next = self.queue.advance(self.repeat, true, &mut self.rng);
        self.failures = 0;
        self.go_to(next);
    }

    /// « Précédent »: the start of the track past a few seconds, else the
    /// track before.
    pub fn previous(&mut self) {
        if self.position() > RESTART_AFTER || self.queue.current().is_none() {
            self.seek(Duration::ZERO);
            return;
        }
        let back = self.queue.back(self.repeat);
        self.go_to(back);
    }

    /// Plays the track at `position` in the queue.
    pub fn jump(&mut self, position: usize) {
        if let Some(id) = self.queue.jump(position) {
            self.failures = 0;
            self.go_to(Some(id));
        }
    }

    pub fn seek(&mut self, to: Duration) {
        let seeked = match &self.sink {
            Some(sink) if !self.loaded.is_empty() => sink.seek(to).is_ok(),
            _ => false,
        };
        if !seeked {
            self.start_at = to;
        }
        // Past the preload point, the track added is dropped: it is added again.
        self.drop_preloaded();
    }

    pub fn remove(&mut self, position: usize) {
        if self.queue.remove(position) {
            let current = self.queue.current();
            if self.playing {
                self.go_to(current);
            } else {
                self.unload();
                self.current = current.and_then(|id| self.library.playable(id));
                self.start_at = Duration::ZERO;
            }
        } else {
            self.follow_queue();
        }
    }

    pub fn move_track(&mut self, from: usize, to: usize) {
        self.queue.move_track(from, to);
        self.follow_queue();
    }

    /// Empties the queue and stops.
    pub fn clear(&mut self) {
        self.queue.clear();
        self.unload();
        self.playing = false;
        self.current = None;
        self.start_at = Duration::ZERO;
    }

    pub fn set_volume(&mut self, volume: f32) {
        self.volume = volume.clamp(0.0, 1.0);
        self.apply_volume();
    }

    pub fn set_muted(&mut self, muted: bool) {
        self.muted = muted;
        self.apply_volume();
    }

    pub fn set_repeat(&mut self, repeat: Repeat) {
        self.repeat = repeat;
        self.follow_queue();
    }

    pub fn set_shuffle(&mut self, shuffle: bool) {
        self.queue.set_shuffle(shuffle, &mut self.rng);
        self.follow_queue();
    }

    /// Called a few times a second while it plays: the next track added
    /// before the end of the current one, and the queue moved on when it
    /// ends. True when the track changed (or the player stopped).
    pub fn tick(&mut self) -> bool {
        let Some(sink) = &self.sink else {
            return false;
        };
        let queued = sink.len();
        if self.loaded.len() > queued {
            // The current track ended: the one added after it plays, or nothing.
            let ended = self.loaded.len() - queued;
            self.loaded.drain(..ended);
            let next = self.queue.advance(self.repeat, false, &mut self.rng);
            self.failures = 0;
            if next.is_some() && next == self.loaded.first().copied() {
                self.current = next.and_then(|id| self.library.playable(id));
            } else {
                self.go_to(next);
            }
            return true;
        }
        self.preload();
        false
    }

    /// The track the queue now has as current, played from `at`.
    fn start_current(&mut self, at: Duration) {
        self.unload();
        self.start_at = at;
        while let Some(id) = self.queue.current() {
            match self.load(id) {
                Ok(()) => {
                    let sink = self.sink.as_ref().map(|sink| {
                        if !at.is_zero() {
                            // A position that cannot be reached: from the start.
                            let _ = sink.seek(at);
                        }
                        sink.play();
                    });
                    self.playing = sink.is_some();
                    self.start_at = Duration::ZERO;
                    return;
                }
                Err(Some(notice)) => {
                    // No output: nothing will play, whatever the track.
                    self.notice = Some(notice);
                    self.playing = false;
                    return;
                }
                Err(None) => {
                    self.failures += 1;
                    if self.failures >= MAX_FAILURES {
                        self.notice = Some(Notice::Stopped);
                        self.playing = false;
                        return;
                    }
                    if self
                        .queue
                        .advance(self.repeat, true, &mut self.rng)
                        .is_none()
                    {
                        break;
                    }
                }
            }
        }
        self.playing = false;
    }

    /// Plays `id` (the queue's current track), or stops at the end.
    fn go_to(&mut self, id: Option<TrackId>) {
        if id.is_some() {
            self.start_current(Duration::ZERO);
        } else {
            // The end of the queue: back to the start of its last track, paused.
            self.unload();
            self.playing = false;
            self.start_at = Duration::ZERO;
            self.current = self
                .queue
                .current()
                .and_then(|id| self.library.playable(id));
        }
    }

    /// Puts `id` in the sink, alone. Err(None) when the track cannot be
    /// played (the notice says why), Err(Some) when nothing can.
    fn load(&mut self, id: TrackId) -> Result<(), Option<Notice>> {
        let track = self.library.playable(id);
        self.current.clone_from(&track);
        let Some(track) = track else {
            return Err(None);
        };
        if let Some(skip) = track.skip {
            self.skipped(&track, skip_reason(skip));
            return Err(None);
        }
        if self.sink.is_none() {
            match self.output.sink() {
                Ok(sink) => self.sink = Some(sink),
                Err(AudioError::NoOutput { message } | AudioError::Unreadable { message }) => {
                    return Err(Some(Notice::NoOutput { message }));
                }
            }
        }
        self.apply_volume();
        let sink = self.sink.as_mut().ok_or(None)?;
        if sink.append(&track.path).is_err() {
            self.skipped(&track, SkipReason::Unreadable);
            return Err(None);
        }
        self.loaded = vec![id];
        Ok(())
    }

    fn skipped(&mut self, track: &Playable, reason: SkipReason) {
        self.notice = Some(Notice::Skipped {
            title: track.title.clone(),
            reason,
        });
    }

    /// Adds the next track to the sink, near the end of the current one.
    fn preload(&mut self) {
        if !self.playing || self.loaded.len() != 1 {
            return;
        }
        let Some(next) = self.queue.upcoming(self.repeat) else {
            return;
        };
        let near_end = self
            .current
            .as_ref()
            .and_then(|c| c.duration_ms)
            .is_some_and(|ms| Duration::from_millis(ms).saturating_sub(self.position()) <= PRELOAD);
        if !near_end {
            return;
        }
        let Some(track) = self.library.playable(next).filter(|t| t.skip.is_none()) else {
            return;
        };
        if let Some(sink) = &mut self.sink
            && sink.append(&track.path).is_ok()
        {
            self.loaded.push(next);
        }
    }

    /// The queue changed: a track added to follow the current one that no
    /// longer comes next is dropped (the current one reloaded where it is).
    fn follow_queue(&mut self) {
        if self.loaded.len() > 1 && self.loaded.get(1).copied() != self.queue.upcoming(self.repeat)
        {
            self.drop_preloaded();
        }
        if self.queue.current().is_none() && self.current.is_some() {
            self.clear_current();
        }
    }

    fn drop_preloaded(&mut self) {
        if self.loaded.len() < 2 {
            return;
        }
        let at = self.position();
        let playing = self.playing;
        self.start_current(at);
        if !playing {
            self.pause();
        }
    }

    fn clear_current(&mut self) {
        self.unload();
        self.current = None;
        self.playing = false;
    }

    fn unload(&mut self) {
        self.sink = None;
        self.loaded.clear();
    }

    fn apply_volume(&self) {
        if let Some(sink) = &self.sink {
            sink.set_volume(if self.muted { 0.0 } else { self.volume });
        }
    }

    /// Keeps what the player has now for the next launch.
    pub fn remember(&self) {
        self.library.remember(&self.memory());
    }
}

fn skip_reason(skip: Skip) -> SkipReason {
    match skip {
        Skip::Gone => SkipReason::Gone,
        Skip::Format => SkipReason::Format,
    }
}

fn duration_ms(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
pub(crate) mod tests;
